import { CanvasCourse, CanvasAssignment, GradescopeCourse, GradescopeAssignment } from "./types.js";
import { AnalyzedAssignment } from "./analyzer.js";
import { Draft, SolutionContext } from "./generator.js";

// Workflow action types
export type WorkflowAction =
  | "resolve_course"
  | "resolve_assignment"
  | "analyze_assignment"
  | "prepare_solution"
  | "generate_solution"
  | "save_draft"
  | "review_draft"
  | "approve_draft"
  | "submit_assignment"
  | "error";

export interface WorkflowLogEntry {
  timestamp: Date;
  action: WorkflowAction;
  details: string;
  data?: Record<string, unknown>;
  success: boolean;
  error?: string;
}

export interface WorkflowSession {
  id: string;
  startedAt: Date;
  completedAt?: Date;
  status: "in_progress" | "awaiting_review" | "approved" | "submitted" | "failed";

  // Request info
  originalRequest: string;

  // Resolved entities
  canvasCourse?: CanvasCourse;
  canvasAssignment?: CanvasAssignment;
  gradescopeCourse?: GradescopeCourse;
  gradescopeAssignment?: GradescopeAssignment;

  // Analysis and generation
  analysis?: AnalyzedAssignment;
  solutionContext?: SolutionContext;
  generatedPrompt?: string;

  // Draft
  draft?: Draft;

  // Submission
  submissionUrl?: string;

  // Logs
  logs: WorkflowLogEntry[];
}

export class WorkflowOrchestrator {
  private sessions: Map<string, WorkflowSession> = new Map();
  private sessionCounter = 0;

  // Create a new workflow session
  createSession(originalRequest: string): WorkflowSession {
    const id = `wf-${Date.now()}-${++this.sessionCounter}`;
    const session: WorkflowSession = {
      id,
      startedAt: new Date(),
      status: "in_progress",
      originalRequest,
      logs: [],
    };

    this.sessions.set(id, session);
    this.log(session, "resolve_course", "Workflow session started", { originalRequest }, true);

    return session;
  }

  getSession(id: string): WorkflowSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): WorkflowSession[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): WorkflowSession[] {
    return this.getAllSessions().filter(s =>
      s.status === "in_progress" || s.status === "awaiting_review"
    );
  }

  // Logging
  log(
    session: WorkflowSession,
    action: WorkflowAction,
    details: string,
    data?: Record<string, unknown>,
    success: boolean = true,
    error?: string
  ): void {
    session.logs.push({
      timestamp: new Date(),
      action,
      details,
      data,
      success,
      error,
    });
  }

  // Parse natural language course identifier
  parseCourseQuery(query: string): { courseCode?: string; courseName?: string; searchTerms: string[] } {
    const normalized = query.toLowerCase().trim();

    // Common course code patterns: "cs 170", "cs170", "eecs 16a", "math 54"
    const codeMatch = normalized.match(/^([a-z]+)\s*(\d+[a-z]?)$/i);
    if (codeMatch) {
      return {
        courseCode: `${codeMatch[1].toUpperCase()} ${codeMatch[2].toUpperCase()}`,
        searchTerms: [codeMatch[1], codeMatch[2], `${codeMatch[1]}${codeMatch[2]}`],
      };
    }

    // Full course name
    return {
      courseName: query,
      searchTerms: normalized.split(/\s+/).filter(t => t.length > 1),
    };
  }

  // Parse natural language assignment identifier
  parseAssignmentQuery(query: string): { assignmentNumber?: number; assignmentName?: string; searchTerms: string[] } {
    const normalized = query.toLowerCase().trim();

    // Common patterns: "hw 17", "homework 17", "lab 3", "project 2"
    const patterns = [
      /^(hw|homework|lab|project|assignment|ps|pset|problem\s*set)\s*#?(\d+)$/i,
      /^(\d+)$/,  // Just a number
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        const num = parseInt(match[2] || match[1]);
        return {
          assignmentNumber: num,
          searchTerms: [match[1] || "", String(num)].filter(Boolean),
        };
      }
    }

    return {
      assignmentName: query,
      searchTerms: normalized.split(/\s+/).filter(t => t.length > 1),
    };
  }

  // Find best matching course
  findCourse(
    courses: CanvasCourse[],
    query: string
  ): { course: CanvasCourse; confidence: number } | null {
    const parsed = this.parseCourseQuery(query);

    let bestMatch: CanvasCourse | null = null;
    let bestScore = 0;

    for (const course of courses) {
      const courseLower = course.name.toLowerCase();
      const codeLower = course.course_code.toLowerCase();

      let score = 0;

      // Exact code match (highest priority)
      if (parsed.courseCode) {
        if (codeLower.includes(parsed.courseCode.toLowerCase())) {
          score = 100;
        } else if (courseLower.includes(parsed.courseCode.toLowerCase())) {
          score = 90;
        }
      }

      // Search term matches
      for (const term of parsed.searchTerms) {
        if (codeLower.includes(term)) score += 30;
        if (courseLower.includes(term)) score += 20;
      }

      // Check for common course code in name (e.g., "CS 170" in "Introduction to CS 170")
      const codeInName = courseLower.match(/([a-z]+)\s*(\d+[a-z]?)/i);
      if (codeInName && parsed.searchTerms.some(t =>
        codeInName[1].includes(t) || codeInName[2].includes(t)
      )) {
        score += 40;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = course;
      }
    }

    if (bestMatch && bestScore >= 20) {
      return { course: bestMatch, confidence: Math.min(bestScore, 100) };
    }

    return null;
  }

  // Find best matching assignment
  findAssignment(
    assignments: CanvasAssignment[],
    query: string
  ): { assignment: CanvasAssignment; confidence: number } | null {
    const parsed = this.parseAssignmentQuery(query);

    let bestMatch: CanvasAssignment | null = null;
    let bestScore = 0;

    for (const assignment of assignments) {
      const nameLower = assignment.name.toLowerCase();
      let score = 0;

      // Number match (e.g., "17" in "Homework 17")
      if (parsed.assignmentNumber !== undefined) {
        const numPattern = new RegExp(`\\b${parsed.assignmentNumber}\\b`);
        if (numPattern.test(assignment.name)) {
          score += 60;
        }
        // Also check for padded numbers like "HW07"
        const paddedNum = String(parsed.assignmentNumber).padStart(2, '0');
        if (assignment.name.includes(paddedNum)) {
          score += 50;
        }
      }

      // Search term matches
      for (const term of parsed.searchTerms) {
        if (nameLower.includes(term)) score += 25;
      }

      // Common prefixes
      const prefixes = ['hw', 'homework', 'lab', 'project', 'assignment'];
      for (const prefix of prefixes) {
        if (nameLower.startsWith(prefix) && parsed.searchTerms.includes(prefix)) {
          score += 20;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = assignment;
      }
    }

    if (bestMatch && bestScore >= 25) {
      return { assignment: bestMatch, confidence: Math.min(bestScore, 100) };
    }

    return null;
  }

  // Update session with resolved course
  setCourse(session: WorkflowSession, course: CanvasCourse, confidence: number): void {
    session.canvasCourse = course;
    this.log(session, "resolve_course", `Resolved course: ${course.name}`, {
      courseId: course.id,
      courseName: course.name,
      courseCode: course.course_code,
      confidence,
    }, true);
  }

  // Update session with resolved assignment
  setAssignment(session: WorkflowSession, assignment: CanvasAssignment, confidence: number): void {
    session.canvasAssignment = assignment;
    this.log(session, "resolve_assignment", `Resolved assignment: ${assignment.name}`, {
      assignmentId: assignment.id,
      assignmentName: assignment.name,
      dueAt: assignment.due_at,
      confidence,
    }, true);
  }

  // Update session with analysis
  setAnalysis(session: WorkflowSession, analysis: AnalyzedAssignment): void {
    session.analysis = analysis;
    this.log(session, "analyze_assignment", `Analyzed: ${analysis.type}, automatable: ${analysis.automatable}`, {
      type: analysis.type,
      automatable: analysis.automatable,
      reason: analysis.automatableReason,
    }, true);
  }

  // Update session with solution context and prompt
  setSolutionContext(session: WorkflowSession, context: SolutionContext, prompt: string): void {
    session.solutionContext = context;
    session.generatedPrompt = prompt;
    this.log(session, "prepare_solution", `Prepared ${context.format} solution context`, {
      format: context.format,
      constraints: context.constraints,
      promptLength: prompt.length,
    }, true);
  }

  // Update session with draft
  setDraft(session: WorkflowSession, draft: Draft): void {
    session.draft = draft;
    session.status = "awaiting_review";
    this.log(session, "save_draft", `Draft saved: ${draft.content.length} characters`, {
      draftId: draft.id,
      format: draft.format,
      wordCount: draft.content.split(/\s+/).filter(w => w.length > 0).length,
    }, true);
  }

  // Approve draft
  approveDraft(session: WorkflowSession): void {
    if (session.draft) {
      session.draft.status = "approved";
      session.status = "approved";
      this.log(session, "approve_draft", "Draft approved for submission", {
        draftId: session.draft.id,
      }, true);
    }
  }

  // Record submission
  recordSubmission(session: WorkflowSession, url: string): void {
    session.submissionUrl = url;
    session.status = "submitted";
    session.completedAt = new Date();
    if (session.draft) {
      session.draft.status = "submitted";
    }
    this.log(session, "submit_assignment", `Submitted successfully`, {
      url,
    }, true);
  }

  // Record error
  recordError(session: WorkflowSession, error: string): void {
    session.status = "failed";
    this.log(session, "error", error, {}, false, error);
  }

  // Generate session summary
  getSummary(session: WorkflowSession): string {
    const lines: string[] = [];

    lines.push(`# Workflow Session: ${session.id}`);
    lines.push("");
    lines.push(`**Request:** ${session.originalRequest}`);
    lines.push(`**Status:** ${session.status}`);
    lines.push(`**Started:** ${session.startedAt.toLocaleString()}`);
    if (session.completedAt) {
      lines.push(`**Completed:** ${session.completedAt.toLocaleString()}`);
    }
    lines.push("");

    if (session.canvasCourse) {
      lines.push(`**Course:** ${session.canvasCourse.name} (${session.canvasCourse.course_code})`);
    }
    if (session.canvasAssignment) {
      lines.push(`**Assignment:** ${session.canvasAssignment.name}`);
      if (session.canvasAssignment.due_at) {
        lines.push(`**Due:** ${new Date(session.canvasAssignment.due_at).toLocaleString()}`);
      }
    }
    if (session.analysis) {
      lines.push(`**Type:** ${session.analysis.type}`);
      lines.push(`**Automatable:** ${session.analysis.automatable ? "Yes" : "No"}`);
    }
    if (session.draft) {
      const wordCount = session.draft.content.split(/\s+/).filter(w => w.length > 0).length;
      lines.push(`**Draft:** ${wordCount} words, status: ${session.draft.status}`);
    }
    if (session.submissionUrl) {
      lines.push(`**Submission:** ${session.submissionUrl}`);
    }
    lines.push("");

    lines.push("## Activity Log");
    lines.push("");
    for (const log of session.logs) {
      const time = log.timestamp.toLocaleTimeString();
      const status = log.success ? "✓" : "✗";
      lines.push(`${time} [${status}] **${log.action}**: ${log.details}`);
      if (log.error) {
        lines.push(`  Error: ${log.error}`);
      }
    }

    return lines.join("\n");
  }

  // Generate full documentation for a completed workflow
  getDocumentation(session: WorkflowSession): string {
    const lines: string[] = [];

    lines.push("═".repeat(60));
    lines.push("ASSIGNMENT COMPLETION REPORT");
    lines.push("═".repeat(60));
    lines.push("");

    lines.push(`Session ID: ${session.id}`);
    lines.push(`Date: ${session.startedAt.toLocaleDateString()}`);
    lines.push(`Duration: ${this.formatDuration(session.startedAt, session.completedAt || new Date())}`);
    lines.push("");

    lines.push("─".repeat(60));
    lines.push("REQUEST");
    lines.push("─".repeat(60));
    lines.push(session.originalRequest);
    lines.push("");

    if (session.canvasCourse && session.canvasAssignment) {
      lines.push("─".repeat(60));
      lines.push("RESOLVED TO");
      lines.push("─".repeat(60));
      lines.push(`Course: ${session.canvasCourse.name}`);
      lines.push(`Code: ${session.canvasCourse.course_code}`);
      lines.push(`Assignment: ${session.canvasAssignment.name}`);
      if (session.canvasAssignment.due_at) {
        lines.push(`Due: ${new Date(session.canvasAssignment.due_at).toLocaleString()}`);
      }
      lines.push(`Points: ${session.canvasAssignment.points_possible}`);
      lines.push("");
    }

    if (session.analysis) {
      lines.push("─".repeat(60));
      lines.push("ANALYSIS");
      lines.push("─".repeat(60));
      lines.push(`Type: ${session.analysis.type}`);
      lines.push(`Automatable: ${session.analysis.automatable}`);
      lines.push(`Reason: ${session.analysis.automatableReason}`);
      if (session.analysis.requirements.wordCount?.min) {
        lines.push(`Word Count Required: ${session.analysis.requirements.wordCount.min}+`);
      }
      if (session.analysis.requirements.citations) {
        lines.push(`Citations: Required (${session.analysis.requirements.citationStyle || "unspecified style"})`);
      }
      lines.push("");
    }

    if (session.draft) {
      lines.push("─".repeat(60));
      lines.push("SOLUTION");
      lines.push("─".repeat(60));
      lines.push(`Format: ${session.draft.format}`);
      const wordCount = session.draft.content.split(/\s+/).filter(w => w.length > 0).length;
      lines.push(`Word Count: ${wordCount}`);
      lines.push(`Status: ${session.draft.status}`);
      lines.push("");
      lines.push("Content Preview (first 500 chars):");
      lines.push("```");
      lines.push(session.draft.content.substring(0, 500) + (session.draft.content.length > 500 ? "..." : ""));
      lines.push("```");
      lines.push("");
    }

    lines.push("─".repeat(60));
    lines.push("OUTCOME");
    lines.push("─".repeat(60));
    lines.push(`Final Status: ${session.status.toUpperCase()}`);
    if (session.submissionUrl) {
      lines.push(`Submission URL: ${session.submissionUrl}`);
    }
    lines.push("");

    lines.push("─".repeat(60));
    lines.push("DETAILED LOG");
    lines.push("─".repeat(60));
    for (const log of session.logs) {
      const time = log.timestamp.toISOString();
      lines.push(`[${time}] ${log.action}: ${log.details}`);
      if (log.data) {
        lines.push(`  Data: ${JSON.stringify(log.data)}`);
      }
      if (log.error) {
        lines.push(`  ERROR: ${log.error}`);
      }
    }
    lines.push("");
    lines.push("═".repeat(60));

    return lines.join("\n");
  }

  private formatDuration(start: Date, end: Date): string {
    const ms = end.getTime() - start.getTime();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
