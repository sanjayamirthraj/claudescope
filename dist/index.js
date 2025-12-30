#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";
import FormData from "form-data";
import fs from "fs";
import path from "path";
const GRADESCOPE_BASE_URL = "https://www.gradescope.com";
class GradescopeClient {
    cookies = [];
    loggedIn = false;
    getCookieHeader() {
        return this.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    parseCookies(setCookieHeaders) {
        for (const header of setCookieHeaders) {
            const match = header.match(/^([^=]+)=([^;]*)/);
            if (match) {
                const existing = this.cookies.findIndex((c) => c.name === match[1]);
                if (existing >= 0) {
                    this.cookies[existing].value = match[2];
                }
                else {
                    this.cookies.push({ name: match[1], value: match[2] });
                }
            }
        }
    }
    async getAuthToken() {
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
    async login(email, password) {
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
    async getCourses() {
        if (!this.loggedIn)
            throw new Error("Not logged in");
        const response = await fetch(`${GRADESCOPE_BASE_URL}/account`, {
            headers: { Cookie: this.getCookieHeader() },
        });
        const html = await response.text();
        const $ = cheerio.load(html);
        const courses = {
            instructor: [],
            student: [],
        };
        $(".courseList").each((_, list) => {
            const $list = $(list);
            const isInstructor = $list.prev("h1").text().toLowerCase().includes("instructor") ||
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
    async getAssignments(courseId) {
        if (!this.loggedIn)
            throw new Error("Not logged in");
        const response = await fetch(`${GRADESCOPE_BASE_URL}/courses/${courseId}`, { headers: { Cookie: this.getCookieHeader() } });
        const html = await response.text();
        const $ = cheerio.load(html);
        const assignments = [];
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
                if (i === 0 && !name)
                    return;
                if (text.match(/\d{4}/))
                    dueDate = text;
                else if (text.includes("Submitted") ||
                    text.includes("Not Submitted") ||
                    text.includes("Graded"))
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
    async uploadSubmission(courseId, assignmentId, filePaths) {
        if (!this.loggedIn)
            throw new Error("Not logged in");
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
            body: form,
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
const client = new GradescopeClient();
const server = new Server({ name: "gradescope-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
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
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "gradescope_login": {
                const { email, password } = args;
                const success = await client.login(email, password);
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
            case "gradescope_get_courses": {
                const courses = await client.getCourses();
                return {
                    content: [{ type: "text", text: JSON.stringify(courses, null, 2) }],
                };
            }
            case "gradescope_get_assignments": {
                const { course_id } = args;
                const assignments = await client.getAssignments(course_id);
                return {
                    content: [
                        { type: "text", text: JSON.stringify(assignments, null, 2) },
                    ],
                };
            }
            case "gradescope_upload_submission": {
                const { course_id, assignment_id, file_paths } = args;
                const result = await client.uploadSubmission(course_id, assignment_id, file_paths);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            }
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${message}` }] };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch(console.error);
