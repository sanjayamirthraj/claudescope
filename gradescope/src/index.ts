#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";
import FormData from "form-data";
import fs from "fs";
import path from "path";

// Import Canvas module
import {
  CanvasClient,
  CourseMapper,
  AssignmentAnalyzer,
  SolutionGenerator,
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

  async uploadSubmission(
    courseId: string,
    assignmentId: string,
    filePaths: string[]
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!this.loggedIn) throw new Error("Not logged in");

    const courseUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}`;
    const uploadUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}/assignments/${assignmentId}/submissions`;

    const tokenResponse = await fetch(courseUrl, {
      headers: { Cookie: this.getCookieHeader() },
    });
    const tokenHtml = await tokenResponse.text();
    const $ = cheerio.load(tokenHtml);
    const authToken = $('meta[name="csrf-token"]').attr("content") || "";

    const form = new FormData();
    form.append("utf8", "✓");
    form.append("authenticity_token", authToken);
    form.append("submission[method]", "upload");

    for (const filePath of filePaths) {
      const absolutePath = path.resolve(filePath);
      if (!fs.existsSync(absolutePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }
      const fileStream = fs.createReadStream(absolutePath);
      const fileName = path.basename(absolutePath);
      form.append("submission[files][]", fileStream, fileName);
    }

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Cookie: this.getCookieHeader(),
        Referer: courseUrl,
        ...form.getHeaders(),
      },
      body: form as unknown as BodyInit,
      redirect: "follow",
    });

    const finalUrl = response.url;
    if (finalUrl === courseUrl || finalUrl.endsWith("submissions")) {
      return {
        success: false,
        error: "Upload failed - possibly past due date or invalid submission",
      };
    }

    return { success: true, url: finalUrl };
  }
}

// Initialize clients
const gradescopeClient = new GradescopeClient();
const canvasClient = new CanvasClient();
const courseMapper = new CourseMapper();
const assignmentAnalyzer = new AssignmentAnalyzer();
const solutionGenerator = new SolutionGenerator();

async function autoLogin() {
  const sessionCookie = process.env.GRADESCOPE_SESSION;
  const signedToken = process.env.GRADESCOPE_TOKEN;
  if (sessionCookie && signedToken) {
    const cookieString = `_gradescope_session=${sessionCookie}; signed_token=${signedToken}`;
    await gradescopeClient.loginWithCookies(cookieString);
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
      description: "Login to Gradescope with email and password",
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
        "Login to Gradescope using browser cookies. Get cookies from browser DevTools: Application > Cookies > gradescope.com. Copy the cookie string (especially _gradescope_session and signed_token).",
      inputSchema: {
        type: "object",
        properties: {
          cookies: {
            type: "string",
            description:
              "Cookie string from browser, format: name1=value1; name2=value2",
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
      name: "gradescope_upload_submission",
      description: "Upload files to a Gradescope assignment",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
          assignment_id: { type: "string", description: "The assignment ID" },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description: "Array of file paths to upload",
          },
        },
        required: ["course_id", "assignment_id", "file_paths"],
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

      case "gradescope_upload_submission": {
        const { course_id, assignment_id, file_paths } = args as {
          course_id: string;
          assignment_id: string;
          file_paths: string[];
        };
        const result = await gradescopeClient.uploadSubmission(
          course_id,
          assignment_id,
          file_paths
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
