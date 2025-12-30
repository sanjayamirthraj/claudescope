#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";

// Import Canvas module
import {
  CanvasClient,
  CourseMapper,
  AssignmentAnalyzer,
  SolutionGenerator,
  WorkflowOrchestrator,
  CanvasCourse,
  GradescopeCourse,
  GradescopeAssignment,
  SolutionFormat,
} from "./canvas/index.js";

const GRADESCOPE_BASE_URL = "https://www.gradescope.com";

interface Cookie {
  name: string;
  value: string;
}

interface Grade {
  assignmentId: string;
  assignmentName: string;
  score: string;
  maxScore: string;
  status: string;
}

class GradescopeClient {
  private cookies: Cookie[] = [];
  private loggedIn = false;

  private getCookieHeader(): string {
    return this.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  private parseCookies(setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match) {
        const existing = this.cookies.findIndex((c) => c.name === match[1]);
        if (existing >= 0) {
          this.cookies[existing].value = match[2];
        } else {
          this.cookies.push({ name: match[1], value: match[2] });
        }
      }
    }
  }

  private getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split(".").pop() || "";
    const mimeTypes: Record<string, string> = {
      pdf: "application/pdf",
      txt: "text/plain",
      py: "text/x-python",
      java: "text/x-java",
      cpp: "text/x-c++src",
      c: "text/x-csrc",
      h: "text/x-chdr",
      js: "application/javascript",
      ts: "application/typescript",
      json: "application/json",
      zip: "application/zip",
      tar: "application/x-tar",
      gz: "application/gzip",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  private async getAuthToken(): Promise<string> {
    const response = await fetch(GRADESCOPE_BASE_URL, {
      headers: { Cookie: this.getCookieHeader() },
    });
    const setCookies = response.headers.getSetCookie();
    this.parseCookies(setCookies);
    const html = await response.text();
    const $ = cheerio.load(html);
    const token = $('meta[name="csrf-token"]').attr("content") || "";
    return token;
  }

  async loginWithCookies(cookieString: string): Promise<boolean> {
    const pairs = cookieString.split(";").map((s) => s.trim());
    for (const pair of pairs) {
      const match = pair.match(/^([^=]+)=(.*)$/);
      if (match) {
        const existing = this.cookies.findIndex((c) => c.name === match[1]);
        if (existing >= 0) {
          this.cookies[existing].value = match[2];
        } else {
          this.cookies.push({ name: match[1], value: match[2] });
        }
      }
    }
    const response = await fetch(`${GRADESCOPE_BASE_URL}/account`, {
      headers: { Cookie: this.getCookieHeader() },
      redirect: "manual",
    });
    if (response.status === 200) {
      this.loggedIn = true;
      return true;
    }
    return false;
  }

  async login(email: string, password: string): Promise<boolean> {
    const authToken = await this.getAuthToken();

    const formData = new URLSearchParams();
    formData.append("utf8", "✓");
    formData.append("authenticity_token", authToken);
    formData.append("session[email]", email);
    formData.append("session[password]", password);
    formData.append("session[remember_me]", "1");
    formData.append("commit", "Log In");
    formData.append("session[remember_me_sso]", "0");

    const response = await fetch(`${GRADESCOPE_BASE_URL}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.getCookieHeader(),
        Referer: GRADESCOPE_BASE_URL,
      },
      body: formData.toString(),
      redirect: "manual",
    });

    const setCookies = response.headers.getSetCookie();
    this.parseCookies(setCookies);

    if (response.status === 302 || response.status === 303) {
      const location = response.headers.get("location") || "";
      if (!location.includes("login")) {
        this.loggedIn = true;
        return true;
      }
    }

    return false;
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  async getCourses(): Promise<{ instructor: GradescopeCourse[]; student: GradescopeCourse[] }> {
    if (!this.loggedIn) throw new Error("Not logged in");

    const response = await fetch(`${GRADESCOPE_BASE_URL}/account`, {
      headers: { Cookie: this.getCookieHeader() },
    });
    const html = await response.text();
    const $ = cheerio.load(html);

    const courses: { instructor: GradescopeCourse[]; student: GradescopeCourse[] } = {
      instructor: [],
      student: [],
    };

    $(".courseList").each((_, list) => {
      const $list = $(list);
      const isInstructor =
        $list.prev("h1").text().toLowerCase().includes("instructor") ||
        $list.prev("h2").text().toLowerCase().includes("instructor");
      const role = isInstructor ? "instructor" : "student";
      const courseArray = isInstructor ? courses.instructor : courses.student;

      $list.find(".courseBox").each((_, box) => {
        const $box = $(box);
        const href = $box.attr("href") || "";
        const idMatch = href.match(/\/courses\/(\d+)/);
        const id = idMatch ? idMatch[1] : "";
        const name = $box.find(".courseBox--shortname").text().trim();
        const shortName = $box.find(".courseBox--shortname").text().trim();
        const term = $box.find(".courseBox--term").text().trim();

        if (id) {
          courseArray.push({ id, name, shortName, term, role });
        }
      });
    });

    return courses;
  }

  async getAssignments(courseId: string): Promise<GradescopeAssignment[]> {
    if (!this.loggedIn) throw new Error("Not logged in");

    const response = await fetch(
      `${GRADESCOPE_BASE_URL}/courses/${courseId}`,
      { headers: { Cookie: this.getCookieHeader() } }
    );
    const html = await response.text();
    const $ = cheerio.load(html);

    const assignments: GradescopeAssignment[] = [];

    $("table.table tbody tr").each((_, row) => {
      const $row = $(row);
      const $link = $row.find("th a, td a").first();
      const href = $link.attr("href") || "";
      const idMatch = href.match(/\/assignments\/(\d+)/);
      const id = idMatch ? idMatch[1] : "";
      const name = $link.text().trim();

      const cells = $row.find("td");
      let dueDate = "";
      let status = "";
      let score = "";

      cells.each((i, cell) => {
        const text = $(cell).text().trim();
        if (i === 0 && !name) return;
        if (text.match(/\d{4}/)) dueDate = text;
        else if (
          text.includes("Submitted") ||
          text.includes("Not Submitted") ||
          text.includes("Graded")
        )
          status = text;
        else if (text.match(/\d+\/\d+/) || text.match(/\d+\.\d+/))
          score = text;
      });

      if (id && name) {
        assignments.push({ id, name, dueDate, status, score });
      }
    });

    $(".assignments-student-table tr, .assignmentsTable tr").each((_, row) => {
      const $row = $(row);
      const $link = $row.find("a").first();
      const href = $link.attr("href") || "";
      const idMatch = href.match(/\/assignments\/(\d+)/);
      const id = idMatch ? idMatch[1] : "";
      const name = $link.text().trim() || $row.find("th").first().text().trim();

      if (id && name && !assignments.find((a) => a.id === id)) {
        const timeElem = $row.find("time");
        const dueDate = timeElem.attr("datetime") || timeElem.text().trim();
        const statusElem = $row.find(".submissionStatus, .submission-status");
        const status = statusElem.text().trim();
        const scoreElem = $row.find(".submissionScore, .score");
        const score = scoreElem.text().trim();

        assignments.push({ id, name, dueDate, status, score });
      }
    });

    return assignments;
  }

  async getGrades(courseId: string): Promise<Grade[]> {
    if (!this.loggedIn) throw new Error("Not logged in");

    const response = await fetch(
      `${GRADESCOPE_BASE_URL}/courses/${courseId}`,
      { headers: { Cookie: this.getCookieHeader() } }
    );
    const html = await response.text();
    const $ = cheerio.load(html);

    const grades: Grade[] = [];

    $("table tbody tr, .assignmentTable--row").each((_, row) => {
      const $row = $(row);
      const $link = $row.find("a").first();
      const href = $link.attr("href") || "";
      const idMatch = href.match(/\/assignments\/(\d+)/);
      if (!idMatch) return;

      const assignmentId = idMatch[1];
      const assignmentName = $link.text().trim();
      if (!assignmentName) return;

      let score = "";
      let maxScore = "";
      let status = "";

      $row.find("td").each((_, cell) => {
        const cellText = $(cell).text().trim();
        const scoreMatch = cellText.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
        if (scoreMatch) {
          score = scoreMatch[1];
          maxScore = scoreMatch[2];
        }
        if (cellText === "Submitted" || cellText === "Graded" || cellText === "No Submission" || cellText.includes("Ungraded")) {
          status = cellText;
        }
      });

      grades.push({ assignmentId, assignmentName, score, maxScore, status });
    });

    return grades;
  }

  async getSubmissions(
    courseId: string,
    assignmentId: string
  ): Promise<{
    submissions: Array<{
      id: string;
      submittedAt: string;
      score: string;
      status: string;
      isLatest: boolean;
    }>;
    assignmentName: string;
    hasSubmission: boolean;
  }> {
    if (!this.loggedIn) throw new Error("Not logged in");

    const submissionsUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const response = await fetch(submissionsUrl, {
      headers: { Cookie: this.getCookieHeader() },
    });
    const html = await response.text();
    const $ = cheerio.load(html);

    const submissions: Array<{
      id: string;
      submittedAt: string;
      score: string;
      status: string;
      isLatest: boolean;
    }> = [];

    // Get assignment name from the page
    const assignmentName = $("h1, .assignment-title, .assignmentTitle").first().text().trim() || "Unknown Assignment";

    // Parse submission history table
    $(".submissionHistoryTable tr, table.table tbody tr, .submission-history tr").each((index, row) => {
      const $row = $(row);

      // Skip header rows
      if ($row.find("th").length > 0) return;

      const $link = $row.find("a").first();
      const href = $link.attr("href") || "";
      const idMatch = href.match(/\/submissions\/(\d+)/);
      const id = idMatch ? idMatch[1] : "";

      if (!id) return;

      // Get submission time
      const timeElem = $row.find("time");
      const submittedAt = timeElem.attr("datetime") || timeElem.text().trim() || $row.find("td").eq(0).text().trim();

      // Get score
      const scoreText = $row.find(".score, .submissionScore, td:contains('/')").text().trim();
      const score = scoreText.match(/[\d.]+\s*\/\s*[\d.]+/) ? scoreText : "";

      // Get status
      let status = "";
      $row.find("td").each((_, cell) => {
        const text = $(cell).text().trim();
        if (text.includes("Graded") || text.includes("Submitted") || text.includes("Processing") || text.includes("Pending")) {
          status = text;
        }
      });

      // First submission in the list is typically the latest
      submissions.push({
        id,
        submittedAt,
        score,
        status: status || "Submitted",
        isLatest: index === 0,
      });
    });

    // Also check for single submission display (some assignments show just one)
    if (submissions.length === 0) {
      const singleSubmissionLink = $("a[href*='/submissions/']").first();
      const href = singleSubmissionLink.attr("href") || "";
      const idMatch = href.match(/\/submissions\/(\d+)/);
      if (idMatch) {
        submissions.push({
          id: idMatch[1],
          submittedAt: $("time").first().text().trim() || "Unknown",
          score: $(".score").first().text().trim() || "",
          status: "Submitted",
          isLatest: true,
        });
      }
    }

    return {
      submissions,
      assignmentName,
      hasSubmission: submissions.length > 0,
    };
  }

  async uploadSubmission(
    courseId: string,
    assignmentId: string,
    filePaths?: string[],
    fileContents?: Array<{ filename: string; content: string }>
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!this.loggedIn) throw new Error("Not logged in");

    // Must provide either file paths or file contents
    if ((!filePaths || filePaths.length === 0) && (!fileContents || fileContents.length === 0)) {
      return { success: false, error: "Must provide either file_paths or file_contents" };
    }

    const courseUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}`;
    const assignmentUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}/assignments/${assignmentId}`;

    // First, check the assignment page to get CSRF token and detect existing submission
    const assignmentResponse = await fetch(assignmentUrl, {
      headers: { Cookie: this.getCookieHeader() },
      redirect: "follow",
    });
    const assignmentHtml = await assignmentResponse.text();
    const $ = cheerio.load(assignmentHtml);
    const authToken = $('meta[name="csrf-token"]').attr("content") || "";

    // The resubmit URL is always /submissions (not /submissions/{id})
    // Gradescope handles creating new submissions vs resubmissions automatically
    const uploadUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}/assignments/${assignmentId}/submissions`;

    // Use the final URL (which may be a submission page) as the referer
    const refererUrl = assignmentResponse.url;

    // Use native FormData (Node.js 18+)
    const formData = new FormData();
    formData.append("utf8", "✓");
    formData.append("authenticity_token", authToken);
    formData.append("submission[method]", "upload");
    formData.append("submission[leaderboard_name]", "");

    // Handle file paths (files on local filesystem)
    if (filePaths && filePaths.length > 0) {
      for (const filePath of filePaths) {
        const absolutePath = path.resolve(filePath);
        if (!fs.existsSync(absolutePath)) {
          return { success: false, error: `File not found: ${filePath}` };
        }
        const fileContent = fs.readFileSync(absolutePath);
        const fileName = path.basename(absolutePath);
        const mimeType = this.getMimeType(fileName);
        const blob = new Blob([fileContent], { type: mimeType });
        formData.append("submission[files][]", blob, fileName);
      }
    }

    // Handle direct file contents (for files uploaded to Claude or provided as text)
    if (fileContents && fileContents.length > 0) {
      for (const file of fileContents) {
        const buffer = Buffer.from(file.content, "utf-8");
        const mimeType = this.getMimeType(file.filename);
        const blob = new Blob([buffer], { type: mimeType });
        formData.append("submission[files][]", blob, file.filename);
      }
    }

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Cookie: this.getCookieHeader(),
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Origin: GRADESCOPE_BASE_URL,
        Referer: refererUrl,
      },
      body: formData,
      redirect: "follow",
    });

    // Parse response - Gradescope returns JSON on success
    const responseText = await response.text();

    try {
      const jsonResponse = JSON.parse(responseText);
      if (jsonResponse.success) {
        const submissionUrl = jsonResponse.url
          ? (jsonResponse.url.startsWith("http") ? jsonResponse.url : `${GRADESCOPE_BASE_URL}${jsonResponse.url}`)
          : response.url;
        return { success: true, url: submissionUrl };
      } else {
        return {
          success: false,
          error: jsonResponse.error || "Upload failed - server returned unsuccessful response"
        };
      }
    } catch {
      // Non-JSON response - check by URL
      const finalUrl = response.url;
      if (response.ok && finalUrl.includes("/submissions/")) {
        return { success: true, url: finalUrl };
      }
      return {
        success: false,
        error: `Upload failed - status ${response.status}: ${responseText.substring(0, 200)}`,
      };
    }
  }
}

// Initialize clients
const gradescopeClient = new GradescopeClient();
const canvasClient = new CanvasClient();
const courseMapper = new CourseMapper();
const assignmentAnalyzer = new AssignmentAnalyzer();
const solutionGenerator = new SolutionGenerator();
const workflowOrchestrator = new WorkflowOrchestrator();

async function autoLogin() {
  // Auto-login to Gradescope
  const sessionCookie = process.env.GRADESCOPE_SESSION;
  const signedToken = process.env.GRADESCOPE_TOKEN;
  if (sessionCookie && signedToken) {
    const cookieString = `_gradescope_session=${sessionCookie}; signed_token=${signedToken}`;
    await gradescopeClient.loginWithCookies(cookieString);
  }

  // Auto-login to Canvas
  const canvasToken = process.env.CANVAS_API_TOKEN;
  if (canvasToken) {
    await canvasClient.login(canvasToken);
  }
}

const server = new Server(
  { name: "gradescope-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Gradescope tools
    {
      name: "gradescope_login",
      description: "Login to Gradescope with email and password (for non-SSO accounts)",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Gradescope email" },
          password: { type: "string", description: "Gradescope password" },
        },
        required: ["email", "password"],
      },
    },
    {
      name: "gradescope_login_with_cookies",
      description:
        "Login to Gradescope using browser cookies (for SSO/CalNet users). Get cookies from browser DevTools: Application > Cookies > gradescope.com",
      inputSchema: {
        type: "object",
        properties: {
          cookies: {
            type: "string",
            description:
              "Cookie string from browser, format: _gradescope_session=xxx; signed_token=yyy",
          },
        },
        required: ["cookies"],
      },
    },
    {
      name: "gradescope_get_courses",
      description: "Get all courses for the logged in user",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "gradescope_get_assignments",
      description: "Get all assignments for a specific course",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
        },
        required: ["course_id"],
      },
    },
    {
      name: "gradescope_get_grades",
      description: "Get grades for all assignments in a course",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
        },
        required: ["course_id"],
      },
    },
    {
      name: "gradescope_upload_submission",
      description: "Upload files to a Gradescope assignment. Provide either file_paths (for local files) or file_contents (for direct content upload).",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
          assignment_id: { type: "string", description: "The assignment ID" },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description: "Array of absolute file paths on the local filesystem to upload",
          },
          file_contents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "The filename (e.g., 'submission.txt')" },
                content: { type: "string", description: "The file content as a string" },
              },
              required: ["filename", "content"],
            },
            description: "Array of files with filename and content to upload directly (use this when you have the file content but not a local path)",
          },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    {
      name: "gradescope_get_submissions",
      description: "Get submission history for a Gradescope assignment. Shows all past submissions with their timestamps, scores, and statuses.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
          assignment_id: { type: "string", description: "The assignment ID" },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    {
      name: "gradescope_resubmit",
      description: "Resubmit to a Gradescope assignment that already has a previous submission. This will create a new submission while preserving the submission history. Returns information about previous submissions before uploading the new one.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
          assignment_id: { type: "string", description: "The assignment ID" },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description: "Array of absolute file paths on the local filesystem to upload",
          },
          file_contents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "The filename (e.g., 'submission.txt')" },
                content: { type: "string", description: "The file content as a string" },
              },
              required: ["filename", "content"],
            },
            description: "Array of files with filename and content to upload directly",
          },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    // Canvas tools
    {
      name: "canvas_login",
      description: "Login to Canvas LMS with an API access token",
      inputSchema: {
        type: "object",
        properties: {
          api_token: { type: "string", description: "Canvas API access token" },
        },
        required: ["api_token"],
      },
    },
    {
      name: "canvas_get_courses",
      description: "Get all active courses for the logged in Canvas user",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "canvas_get_assignments",
      description: "Get all assignments for a specific Canvas course",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
        },
        required: ["course_id"],
      },
    },
    {
      name: "canvas_get_assignment",
      description: "Get detailed information about a specific Canvas assignment including its description",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    // Course mapping tools
    {
      name: "auto_match_courses",
      description: "Automatically match Canvas courses to Gradescope courses by name similarity. Requires both Canvas and Gradescope to be logged in.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_course_mappings",
      description: "Get all current course mappings between Canvas and Gradescope",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "exclude_course",
      description: "Exclude a Canvas course from automatic assignment processing",
      inputSchema: {
        type: "object",
        properties: {
          canvas_course_id: { type: "number", description: "The Canvas course ID to exclude" },
        },
        required: ["canvas_course_id"],
      },
    },
    {
      name: "include_course",
      description: "Re-include a previously excluded Canvas course",
      inputSchema: {
        type: "object",
        properties: {
          canvas_course_id: { type: "number", description: "The Canvas course ID to include" },
        },
        required: ["canvas_course_id"],
      },
    },
    {
      name: "auto_match_assignments",
      description: "Automatically match Canvas assignments to Gradescope assignments for a specific course",
      inputSchema: {
        type: "object",
        properties: {
          canvas_course_id: { type: "number", description: "The Canvas course ID" },
        },
        required: ["canvas_course_id"],
      },
    },
    {
      name: "get_assignment_mappings",
      description: "Get assignment mappings for a specific Canvas course",
      inputSchema: {
        type: "object",
        properties: {
          canvas_course_id: { type: "number", description: "The Canvas course ID" },
        },
        required: ["canvas_course_id"],
      },
    },
    // Assignment analyzer tools
    {
      name: "analyze_assignment",
      description: "Analyze a Canvas assignment to extract requirements, determine type, and check if it can be automated",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    {
      name: "analyze_course_assignments",
      description: "Analyze all assignments in a Canvas course to identify which can be automated",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
        },
        required: ["course_id"],
      },
    },
    // Solution generator tools
    {
      name: "prepare_solution",
      description: "Prepare context and instructions for generating a solution to a Canvas assignment. Returns a prompt that can be used to generate the solution.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    {
      name: "save_draft",
      description: "Save a generated solution as a draft for review before submission",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
          content: { type: "string", description: "The solution content" },
        },
        required: ["course_id", "assignment_id", "content"],
      },
    },
    {
      name: "get_draft",
      description: "Get a saved draft for an assignment",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    {
      name: "list_drafts",
      description: "List all saved drafts",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "update_draft",
      description: "Update the content of an existing draft",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
          content: { type: "string", description: "The updated solution content" },
        },
        required: ["course_id", "assignment_id", "content"],
      },
    },
    {
      name: "approve_draft",
      description: "Mark a draft as approved and ready for submission",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    {
      name: "delete_draft",
      description: "Delete a saved draft",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "number", description: "The Canvas course ID" },
          assignment_id: { type: "number", description: "The Canvas assignment ID" },
        },
        required: ["course_id", "assignment_id"],
      },
    },
    // Workflow tools
    {
      name: "start_assignment",
      description: "Start working on an assignment using natural language. Example: 'hw 17 from cs 170' or 'lab 3 from data structures'. Returns a prompt for generating the solution.",
      inputSchema: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "Natural language description of the assignment, e.g., 'hw 17 from cs 170' or 'complete lab 3 for eecs 16a'",
          },
        },
        required: ["request"],
      },
    },
    {
      name: "save_and_review",
      description: "Save the generated solution and prepare it for review. Call this after generating the solution content.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "The workflow session ID" },
          content: { type: "string", description: "The generated solution content" },
        },
        required: ["session_id", "content"],
      },
    },
    {
      name: "submit_assignment",
      description: "Submit an approved assignment to Gradescope. Only works after the draft has been reviewed and approved.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "The workflow session ID" },
          file_path: { type: "string", description: "Optional: Path to save content as file before uploading (for code submissions)" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "get_workflow_status",
      description: "Get the status and details of a workflow session",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "The workflow session ID" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "list_workflows",
      description: "List all workflow sessions, optionally filtering by status",
      inputSchema: {
        type: "object",
        properties: {
          active_only: { type: "boolean", description: "If true, only show active (in_progress or awaiting_review) sessions" },
        },
      },
    },
    {
      name: "get_workflow_documentation",
      description: "Get full documentation/report for a completed workflow session",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "The workflow session ID" },
        },
        required: ["session_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // Gradescope handlers
      case "gradescope_login": {
        const { email, password } = args as { email: string; password: string };
        const success = await gradescopeClient.login(email, password);
        return {
          content: [
            {
              type: "text",
              text: success
                ? "Successfully logged in to Gradescope"
                : "Login failed - check credentials",
            },
          ],
        };
      }

      case "gradescope_login_with_cookies": {
        const { cookies } = args as { cookies: string };
        const success = await gradescopeClient.loginWithCookies(cookies);
        return {
          content: [
            {
              type: "text",
              text: success
                ? "Successfully logged in to Gradescope with cookies"
                : "Login failed - cookies may be expired or invalid",
            },
          ],
        };
      }

      case "gradescope_get_courses": {
        const courses = await gradescopeClient.getCourses();
        return {
          content: [{ type: "text", text: JSON.stringify(courses, null, 2) }],
        };
      }

      case "gradescope_get_assignments": {
        const { course_id } = args as { course_id: string };
        const assignments = await gradescopeClient.getAssignments(course_id);
        return {
          content: [
            { type: "text", text: JSON.stringify(assignments, null, 2) },
          ],
        };
      }

      case "gradescope_get_grades": {
        const { course_id } = args as { course_id: string };
        const grades = await gradescopeClient.getGrades(course_id);
        return {
          content: [{ type: "text", text: JSON.stringify(grades, null, 2) }],
        };
      }

      case "gradescope_upload_submission": {
        const { course_id, assignment_id, file_paths, file_contents } = args as {
          course_id: string;
          assignment_id: string;
          file_paths?: string[];
          file_contents?: Array<{ filename: string; content: string }>;
        };
        const result = await gradescopeClient.uploadSubmission(
          course_id,
          assignment_id,
          file_paths,
          file_contents
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "gradescope_get_submissions": {
        const { course_id, assignment_id } = args as {
          course_id: string;
          assignment_id: string;
        };
        const result = await gradescopeClient.getSubmissions(course_id, assignment_id);

        if (result.submissions.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No submissions found for assignment: ${result.assignmentName}\n\nUse gradescope_upload_submission to submit for the first time.`,
            }],
          };
        }

        let response = `Submission History for: ${result.assignmentName}\n`;
        response += `Total submissions: ${result.submissions.length}\n\n`;

        result.submissions.forEach((sub, index) => {
          response += `${index + 1}. ${sub.isLatest ? "[LATEST] " : ""}Submission #${sub.id}\n`;
          response += `   Submitted: ${sub.submittedAt}\n`;
          response += `   Status: ${sub.status}\n`;
          if (sub.score) {
            response += `   Score: ${sub.score}\n`;
          }
          response += "\n";
        });

        return {
          content: [{ type: "text", text: response }],
        };
      }

      case "gradescope_resubmit": {
        const { course_id, assignment_id, file_paths, file_contents } = args as {
          course_id: string;
          assignment_id: string;
          file_paths?: string[];
          file_contents?: Array<{ filename: string; content: string }>;
        };

        // First, get existing submissions
        const existingSubmissions = await gradescopeClient.getSubmissions(course_id, assignment_id);

        let response = "";

        if (existingSubmissions.hasSubmission) {
          response += `Previous submissions found for: ${existingSubmissions.assignmentName}\n`;
          response += `Number of previous submissions: ${existingSubmissions.submissions.length}\n`;

          const latest = existingSubmissions.submissions.find(s => s.isLatest);
          if (latest) {
            response += `Latest submission: #${latest.id} at ${latest.submittedAt}`;
            if (latest.score) {
              response += ` (Score: ${latest.score})`;
            }
            response += "\n";
          }
          response += "\n--- Uploading new submission ---\n\n";
        } else {
          response += `No previous submissions found for: ${existingSubmissions.assignmentName}\n`;
          response += "This will be your first submission.\n\n";
        }

        // Now upload the new submission
        const uploadResult = await gradescopeClient.uploadSubmission(
          course_id,
          assignment_id,
          file_paths,
          file_contents
        );

        if (uploadResult.success) {
          response += `Resubmission successful!\n`;
          response += `New submission URL: ${uploadResult.url}\n`;
          response += `\nYour previous ${existingSubmissions.submissions.length} submission(s) are preserved in the history.`;
        } else {
          response += `Resubmission failed: ${uploadResult.error}`;
        }

        return {
          content: [{ type: "text", text: response }],
        };
      }

      // Canvas handlers
      case "canvas_login": {
        const { api_token } = args as { api_token: string };
        const success = await canvasClient.login(api_token);
        return {
          content: [
            {
              type: "text",
              text: success
                ? "Successfully logged in to Canvas"
                : "Login failed - check your API token",
            },
          ],
        };
      }

      case "canvas_get_courses": {
        const courses = await canvasClient.getCourses();
        return {
          content: [{ type: "text", text: JSON.stringify(courses, null, 2) }],
        };
      }

      case "canvas_get_assignments": {
        const { course_id } = args as { course_id: number };
        const assignments = await canvasClient.getAssignments(course_id);
        return {
          content: [{ type: "text", text: JSON.stringify(assignments, null, 2) }],
        };
      }

      case "canvas_get_assignment": {
        const { course_id, assignment_id } = args as {
          course_id: number;
          assignment_id: number;
        };
        const assignment = await canvasClient.getAssignment(course_id, assignment_id);
        return {
          content: [{ type: "text", text: JSON.stringify(assignment, null, 2) }],
        };
      }

      // Course mapping handlers
      case "auto_match_courses": {
        if (!canvasClient.isLoggedIn()) {
          return {
            content: [{ type: "text", text: "Error: Not logged in to Canvas" }],
          };
        }
        if (!gradescopeClient.isLoggedIn()) {
          return {
            content: [{ type: "text", text: "Error: Not logged in to Gradescope" }],
          };
        }

        const canvasCourses = await canvasClient.getCourses();
        const gradescopeCourses = await gradescopeClient.getCourses();
        const allGsCourses = [
          ...gradescopeCourses.instructor,
          ...gradescopeCourses.student,
        ];

        const result = courseMapper.autoMatchCourses(canvasCourses, allGsCourses);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matched: result.matched.length,
                  unmatched: result.unmatched.length,
                  mappings: result.matched,
                  unmatchedCourses: result.unmatched.map((c) => ({
                    id: c.id,
                    name: c.name,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_course_mappings": {
        const mappings = courseMapper.getCourseMappings();
        return {
          content: [{ type: "text", text: JSON.stringify(mappings, null, 2) }],
        };
      }

      case "exclude_course": {
        const { canvas_course_id } = args as { canvas_course_id: number };
        const success = courseMapper.excludeCourse(canvas_course_id);
        return {
          content: [
            {
              type: "text",
              text: success
                ? `Course ${canvas_course_id} excluded from automation`
                : `Course ${canvas_course_id} not found in mappings`,
            },
          ],
        };
      }

      case "include_course": {
        const { canvas_course_id } = args as { canvas_course_id: number };
        const success = courseMapper.includeCourse(canvas_course_id);
        return {
          content: [
            {
              type: "text",
              text: success
                ? `Course ${canvas_course_id} included in automation`
                : `Course ${canvas_course_id} not found in mappings`,
            },
          ],
        };
      }

      case "auto_match_assignments": {
        const { canvas_course_id } = args as { canvas_course_id: number };

        const mapping = courseMapper.getMappingForCanvasCourse(canvas_course_id);
        if (!mapping) {
          return {
            content: [
              {
                type: "text",
                text: `No course mapping found for Canvas course ${canvas_course_id}. Run auto_match_courses first.`,
              },
            ],
          };
        }

        const canvasAssignments = await canvasClient.getAssignments(canvas_course_id);
        const gsAssignments = await gradescopeClient.getAssignments(
          mapping.gradescopeCourseId
        );

        const result = courseMapper.autoMatchAssignments(
          canvas_course_id,
          canvasAssignments,
          gsAssignments
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  matched: result.matched.length,
                  unmatched: result.unmatched.length,
                  mappings: result.matched,
                  unmatchedAssignments: result.unmatched.map((a) => ({
                    id: a.id,
                    name: a.name,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_assignment_mappings": {
        const { canvas_course_id } = args as { canvas_course_id: number };
        const mappings = courseMapper.getAssignmentMappings(canvas_course_id);
        return {
          content: [{ type: "text", text: JSON.stringify(mappings, null, 2) }],
        };
      }

      // Assignment analyzer handlers
      case "analyze_assignment": {
        const { course_id, assignment_id } = args as {
          course_id: number;
          assignment_id: number;
        };

        if (!canvasClient.isLoggedIn()) {
          return {
            content: [{ type: "text", text: "Error: Not logged in to Canvas" }],
          };
        }

        const assignment = await canvasClient.getAssignment(course_id, assignment_id);
        const analysis = assignmentAnalyzer.analyze(assignment, course_id);
        const summary = assignmentAnalyzer.summarize(analysis);

        return {
          content: [
            {
              type: "text",
              text: summary + "\n\n--- Full Analysis ---\n" + JSON.stringify(analysis, null, 2),
            },
          ],
        };
      }

      case "analyze_course_assignments": {
        const { course_id } = args as { course_id: number };

        if (!canvasClient.isLoggedIn()) {
          return {
            content: [{ type: "text", text: "Error: Not logged in to Canvas" }],
          };
        }

        const assignments = await canvasClient.getAssignments(course_id);
        const analyses = assignments.map((a) => assignmentAnalyzer.analyze(a, course_id));

        const automatable = analyses.filter((a) => a.automatable);
        const notAutomatable = analyses.filter((a) => !a.automatable);

        const summary = [
          `=== Course Assignment Analysis ===`,
          `Total assignments: ${analyses.length}`,
          `Automatable: ${automatable.length}`,
          `Not automatable: ${notAutomatable.length}`,
          ``,
          `--- Automatable Assignments ---`,
          ...automatable.map((a) => `• ${a.name} (${a.type}) - ${a.automatableReason}`),
          ``,
          `--- Not Automatable ---`,
          ...notAutomatable.map((a) => `• ${a.name} (${a.type}) - ${a.automatableReason}`),
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: summary,
            },
          ],
        };
      }

      // Solution generator handlers
      case "prepare_solution": {
        const { course_id, assignment_id } = args as {
          course_id: number;
          assignment_id: number;
        };

        if (!canvasClient.isLoggedIn()) {
          return {
            content: [{ type: "text", text: "Error: Not logged in to Canvas" }],
          };
        }

        const assignment = await canvasClient.getAssignment(course_id, assignment_id);
        const analysis = assignmentAnalyzer.analyze(assignment, course_id);

        if (!analysis.automatable) {
          return {
            content: [
              {
                type: "text",
                text: `This assignment cannot be automated: ${analysis.automatableReason}`,
              },
            ],
          };
        }

        const context = solutionGenerator.prepareContext(analysis);
        const prompt = solutionGenerator.generatePrompt(context);

        return {
          content: [
            {
              type: "text",
              text: prompt,
            },
          ],
        };
      }

      case "save_draft": {
        const { course_id, assignment_id, content } = args as {
          course_id: number;
          assignment_id: number;
          content: string;
        };

        if (!canvasClient.isLoggedIn()) {
          return {
            content: [{ type: "text", text: "Error: Not logged in to Canvas" }],
          };
        }

        const assignment = await canvasClient.getAssignment(course_id, assignment_id);
        const analysis = assignmentAnalyzer.analyze(assignment, course_id);
        const context = solutionGenerator.prepareContext(analysis);

        const draft = solutionGenerator.saveDraft(
          assignment_id,
          course_id,
          assignment.name,
          content,
          context.format
        );

        return {
          content: [
            {
              type: "text",
              text: `Draft saved successfully!\n\n${solutionGenerator.formatForReview(draft)}`,
            },
          ],
        };
      }

      case "get_draft": {
        const { course_id, assignment_id } = args as {
          course_id: number;
          assignment_id: number;
        };

        const draft = solutionGenerator.getDraft(course_id, assignment_id);

        if (!draft) {
          return {
            content: [
              {
                type: "text",
                text: `No draft found for assignment ${assignment_id} in course ${course_id}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: solutionGenerator.formatForReview(draft),
            },
          ],
        };
      }

      case "list_drafts": {
        const drafts = solutionGenerator.getAllDrafts();

        if (drafts.length === 0) {
          return {
            content: [{ type: "text", text: "No drafts saved" }],
          };
        }

        const summary = drafts.map((d) => {
          const wordCount = d.content.split(/\s+/).filter((w) => w.length > 0).length;
          return `• ${d.assignmentName} [${d.status}] - ${wordCount} words - Updated: ${d.updatedAt.toLocaleString()}`;
        }).join("\n");

        return {
          content: [
            {
              type: "text",
              text: `=== Saved Drafts (${drafts.length}) ===\n\n${summary}`,
            },
          ],
        };
      }

      case "update_draft": {
        const { course_id, assignment_id, content } = args as {
          course_id: number;
          assignment_id: number;
          content: string;
        };

        const draft = solutionGenerator.updateDraftContent(course_id, assignment_id, content);

        if (!draft) {
          return {
            content: [
              {
                type: "text",
                text: `No draft found for assignment ${assignment_id} in course ${course_id}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Draft updated!\n\n${solutionGenerator.formatForReview(draft)}`,
            },
          ],
        };
      }

      case "approve_draft": {
        const { course_id, assignment_id } = args as {
          course_id: number;
          assignment_id: number;
        };

        const draft = solutionGenerator.updateDraftStatus(course_id, assignment_id, "approved");

        if (!draft) {
          return {
            content: [
              {
                type: "text",
                text: `No draft found for assignment ${assignment_id} in course ${course_id}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Draft approved and ready for submission!\n\nAssignment: ${draft.assignmentName}\nStatus: ${draft.status}\n\nUse gradescope_upload_submission to submit this assignment.`,
            },
          ],
        };
      }

      case "delete_draft": {
        const { course_id, assignment_id } = args as {
          course_id: number;
          assignment_id: number;
        };

        const deleted = solutionGenerator.deleteDraft(course_id, assignment_id);

        return {
          content: [
            {
              type: "text",
              text: deleted
                ? `Draft deleted successfully`
                : `No draft found for assignment ${assignment_id} in course ${course_id}`,
            },
          ],
        };
      }

      // Workflow handlers
      case "start_assignment": {
        const { request } = args as { request: string };

        if (!canvasClient.isLoggedIn()) {
          return {
            content: [{ type: "text", text: "Error: Not logged in to Canvas. Use canvas_login first." }],
          };
        }

        // Create workflow session
        const session = workflowOrchestrator.createSession(request);

        // Parse the request to extract course and assignment
        // Expected formats: "hw 17 from cs 170", "complete lab 3 for eecs 16a", "cs 170 hw 17"
        const fromMatch = request.match(/(.+?)\s+(?:from|for|in)\s+(.+)/i);
        const reverseMatch = request.match(/^([a-z]+\s*\d+[a-z]?)\s+(.+)/i);

        let courseQuery: string;
        let assignmentQuery: string;

        if (fromMatch) {
          assignmentQuery = fromMatch[1].replace(/^complete\s+/i, "").trim();
          courseQuery = fromMatch[2].trim();
        } else if (reverseMatch) {
          courseQuery = reverseMatch[1].trim();
          assignmentQuery = reverseMatch[2].trim();
        } else {
          workflowOrchestrator.recordError(session, "Could not parse request. Use format: 'hw 17 from cs 170' or 'cs 170 hw 17'");
          return {
            content: [{ type: "text", text: `Error: Could not parse request. Use format like:\n- "hw 17 from cs 170"\n- "complete lab 3 for eecs 16a"\n- "cs 170 homework 17"\n\nSession ID: ${session.id}` }],
          };
        }

        // Find the course
        const courses = await canvasClient.getCourses();
        const courseMatch = workflowOrchestrator.findCourse(courses, courseQuery);

        if (!courseMatch) {
          workflowOrchestrator.recordError(session, `Could not find course matching "${courseQuery}"`);
          const availableCourses = courses.slice(0, 5).map(c => `- ${c.name} (${c.course_code})`).join("\n");
          return {
            content: [{ type: "text", text: `Error: Could not find course matching "${courseQuery}"\n\nAvailable courses:\n${availableCourses}\n\nSession ID: ${session.id}` }],
          };
        }

        workflowOrchestrator.setCourse(session, courseMatch.course, courseMatch.confidence);

        // Find the assignment
        const assignments = await canvasClient.getAssignments(courseMatch.course.id);
        const assignmentMatch = workflowOrchestrator.findAssignment(assignments, assignmentQuery);

        if (!assignmentMatch) {
          workflowOrchestrator.recordError(session, `Could not find assignment matching "${assignmentQuery}"`);
          const availableAssignments = assignments.slice(0, 10).map(a => `- ${a.name}`).join("\n");
          return {
            content: [{ type: "text", text: `Error: Could not find assignment matching "${assignmentQuery}" in ${courseMatch.course.name}\n\nAvailable assignments:\n${availableAssignments}\n\nSession ID: ${session.id}` }],
          };
        }

        workflowOrchestrator.setAssignment(session, assignmentMatch.assignment, assignmentMatch.confidence);

        // Get full assignment details and analyze
        const fullAssignment = await canvasClient.getAssignment(courseMatch.course.id, assignmentMatch.assignment.id);
        const analysis = assignmentAnalyzer.analyze(fullAssignment, courseMatch.course.id);
        workflowOrchestrator.setAnalysis(session, analysis);

        if (!analysis.automatable) {
          workflowOrchestrator.recordError(session, `Assignment cannot be automated: ${analysis.automatableReason}`);
          return {
            content: [{ type: "text", text: `Error: This assignment cannot be automated.\nReason: ${analysis.automatableReason}\n\nSession ID: ${session.id}` }],
          };
        }

        // Prepare solution context and prompt
        const context = solutionGenerator.prepareContext(analysis);
        const prompt = solutionGenerator.generatePrompt(context);
        workflowOrchestrator.setSolutionContext(session, context, prompt);

        // Return the prompt for Claude to generate the solution
        const response = [
          `✓ Workflow started: ${session.id}`,
          ``,
          `**Course:** ${courseMatch.course.name} (confidence: ${courseMatch.confidence}%)`,
          `**Assignment:** ${assignmentMatch.assignment.name} (confidence: ${assignmentMatch.confidence}%)`,
          `**Type:** ${analysis.type}`,
          `**Due:** ${assignmentMatch.assignment.due_at ? new Date(assignmentMatch.assignment.due_at).toLocaleString() : "No due date"}`,
          ``,
          `---`,
          ``,
          prompt,
          ``,
          `---`,
          ``,
          `**Next step:** Generate the solution based on the prompt above, then call save_and_review with session_id="${session.id}" and the generated content.`,
        ].join("\n");

        return {
          content: [{ type: "text", text: response }],
        };
      }

      case "save_and_review": {
        const { session_id, content } = args as { session_id: string; content: string };

        const session = workflowOrchestrator.getSession(session_id);
        if (!session) {
          return {
            content: [{ type: "text", text: `Error: Session ${session_id} not found` }],
          };
        }

        if (!session.canvasAssignment || !session.solutionContext) {
          return {
            content: [{ type: "text", text: `Error: Session ${session_id} is incomplete. Use start_assignment first.` }],
          };
        }

        // Save the draft
        const draft = solutionGenerator.saveDraft(
          session.canvasAssignment.id,
          session.canvasCourse!.id,
          session.canvasAssignment.name,
          content,
          session.solutionContext.format
        );

        workflowOrchestrator.setDraft(session, draft);

        const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

        const response = [
          `✓ Draft saved for review`,
          ``,
          `**Session:** ${session.id}`,
          `**Assignment:** ${session.canvasAssignment.name}`,
          `**Format:** ${draft.format}`,
          `**Word Count:** ${wordCount}`,
          `**Status:** ${draft.status}`,
          ``,
          `--- Content Preview (first 1000 chars) ---`,
          ``,
          content.substring(0, 1000) + (content.length > 1000 ? "\n\n... [truncated]" : ""),
          ``,
          `---`,
          ``,
          `**Review the content above.** When ready:`,
          `- To approve and submit: call approve_draft then submit_assignment with session_id="${session.id}"`,
          `- To revise: call save_and_review again with updated content`,
          `- To cancel: no action needed`,
        ].join("\n");

        return {
          content: [{ type: "text", text: response }],
        };
      }

      case "submit_assignment": {
        const { session_id, file_path } = args as { session_id: string; file_path?: string };

        const session = workflowOrchestrator.getSession(session_id);
        if (!session) {
          return {
            content: [{ type: "text", text: `Error: Session ${session_id} not found` }],
          };
        }

        if (!session.draft) {
          return {
            content: [{ type: "text", text: `Error: No draft found for session ${session_id}. Use save_and_review first.` }],
          };
        }

        if (session.draft.status !== "approved") {
          return {
            content: [{ type: "text", text: `Error: Draft must be approved before submission. Current status: ${session.draft.status}\n\nCall approve_draft first with session_id="${session_id}"` }],
          };
        }

        // Check for Gradescope mapping
        const courseMapping = courseMapper.getMappingForCanvasCourse(session.canvasCourse!.id);
        if (!courseMapping) {
          return {
            content: [{ type: "text", text: `Error: No Gradescope course mapping found for ${session.canvasCourse!.name}. Run auto_match_courses first.` }],
          };
        }

        // If file_path provided, write content to file
        let uploadPath = file_path;
        if (!uploadPath && session.solutionContext?.format === "code") {
          // Create temp file for code submissions
          uploadPath = `/tmp/submission_${session_id}.txt`;
          fs.writeFileSync(uploadPath, session.draft.content);
          workflowOrchestrator.log(session, "submit_assignment", `Created temp file: ${uploadPath}`, {}, true);
        } else if (!uploadPath) {
          // For non-code, create a text file
          uploadPath = `/tmp/submission_${session_id}.txt`;
          fs.writeFileSync(uploadPath, session.draft.content);
        }

        // Find Gradescope assignment
        const gsAssignments = await gradescopeClient.getAssignments(courseMapping.gradescopeCourseId);
        const gsMatch = gsAssignments.find(a =>
          a.name.toLowerCase().includes(session.canvasAssignment!.name.toLowerCase()) ||
          session.canvasAssignment!.name.toLowerCase().includes(a.name.toLowerCase())
        );

        if (!gsMatch) {
          return {
            content: [{ type: "text", text: `Error: Could not find matching Gradescope assignment for "${session.canvasAssignment!.name}".\n\nFile saved at: ${uploadPath}\nYou can manually upload this file to Gradescope.` }],
          };
        }

        // Submit to Gradescope
        workflowOrchestrator.log(session, "submit_assignment", `Submitting to Gradescope assignment: ${gsMatch.name}`, {
          gradescopeAssignmentId: gsMatch.id,
        }, true);

        const result = await gradescopeClient.uploadSubmission(
          courseMapping.gradescopeCourseId,
          gsMatch.id,
          [uploadPath]
        );

        if (result.success) {
          workflowOrchestrator.recordSubmission(session, result.url || "");
          const doc = workflowOrchestrator.getDocumentation(session);

          return {
            content: [{ type: "text", text: `✓ Assignment submitted successfully!\n\n**Submission URL:** ${result.url}\n\n---\n\n${doc}` }],
          };
        } else {
          workflowOrchestrator.recordError(session, result.error || "Unknown submission error");
          return {
            content: [{ type: "text", text: `Error submitting assignment: ${result.error}\n\nFile saved at: ${uploadPath}\nYou can manually upload this file.` }],
          };
        }
      }

      case "get_workflow_status": {
        const { session_id } = args as { session_id: string };

        const session = workflowOrchestrator.getSession(session_id);
        if (!session) {
          return {
            content: [{ type: "text", text: `Error: Session ${session_id} not found` }],
          };
        }

        return {
          content: [{ type: "text", text: workflowOrchestrator.getSummary(session) }],
        };
      }

      case "list_workflows": {
        const { active_only } = args as { active_only?: boolean };

        const sessions = active_only
          ? workflowOrchestrator.getActiveSessions()
          : workflowOrchestrator.getAllSessions();

        if (sessions.length === 0) {
          return {
            content: [{ type: "text", text: active_only ? "No active workflows" : "No workflows found" }],
          };
        }

        const list = sessions.map(s => {
          const age = Math.round((Date.now() - s.startedAt.getTime()) / 60000);
          return `• ${s.id} [${s.status}] - "${s.originalRequest}" (${age}m ago)`;
        }).join("\n");

        return {
          content: [{ type: "text", text: `=== Workflows (${sessions.length}) ===\n\n${list}` }],
        };
      }

      case "get_workflow_documentation": {
        const { session_id } = args as { session_id: string };

        const session = workflowOrchestrator.getSession(session_id);
        if (!session) {
          return {
            content: [{ type: "text", text: `Error: Session ${session_id} not found` }],
          };
        }

        return {
          content: [{ type: "text", text: workflowOrchestrator.getDocumentation(session) }],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
});

async function main() {
  await autoLogin();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
