import * as cheerio from "cheerio";
import { CanvasAssignment } from "./types.js";

export interface AnalyzedAssignment {
  // Basic info
  id: number;
  name: string;
  courseId: number;

  // Assignment classification
  type: AssignmentType;
  automatable: boolean;
  automatableReason: string;

  // Requirements
  requirements: AssignmentRequirements;

  // Submission info
  submission: SubmissionInfo;

  // Raw content
  rawDescription: string;
  cleanDescription: string;
}

export type AssignmentType =
  | "essay"
  | "reflection"
  | "code"
  | "quiz"
  | "exam"
  | "presentation"
  | "group_project"
  | "discussion"
  | "lab"
  | "homework"
  | "attendance"
  | "unknown";

export interface AssignmentRequirements {
  wordCount?: { min?: number; max?: number };
  pageCount?: { min?: number; max?: number };
  topics: string[];
  citations: boolean;
  citationStyle?: string;
  rubricItems: string[];
  resources: ResourceLink[];
  keyPhrases: string[];
}

export interface ResourceLink {
  text: string;
  url: string;
}

export interface SubmissionInfo {
  types: string[];
  dueDate: string | null;
  pointsPossible: number;
  allowedFileTypes?: string[];
  isExternalTool: boolean;
  externalToolName?: string;
}

export class AssignmentAnalyzer {

  analyze(assignment: CanvasAssignment, courseId: number): AnalyzedAssignment {
    const cleanDesc = this.cleanHtml(assignment.description || "");
    const requirements = this.extractRequirements(assignment.description || "", cleanDesc);
    const type = this.classifyAssignment(assignment, cleanDesc);
    const submission = this.extractSubmissionInfo(assignment);
    const { automatable, reason } = this.determineAutomatability(type, submission, requirements);

    return {
      id: assignment.id,
      name: assignment.name,
      courseId,
      type,
      automatable,
      automatableReason: reason,
      requirements,
      submission,
      rawDescription: assignment.description || "",
      cleanDescription: cleanDesc,
    };
  }

  private cleanHtml(html: string): string {
    if (!html) return "";

    const $ = cheerio.load(html);

    // Remove script and style tags
    $("script, style, link").remove();

    // Get text content
    let text = $.text();

    // Clean up whitespace
    text = text.replace(/\s+/g, " ").trim();

    return text;
  }

  private extractRequirements(html: string, cleanText: string): AssignmentRequirements {
    const requirements: AssignmentRequirements = {
      topics: [],
      citations: false,
      rubricItems: [],
      resources: [],
      keyPhrases: [],
    };

    // Extract word count
    const wordCountPatterns = [
      /(\d+)[\s-]*word/i,
      /word\s*count[:\s]*(\d+)/i,
      /minimum[:\s]*(\d+)\s*words/i,
      /at\s*least\s*(\d+)\s*words/i,
    ];

    for (const pattern of wordCountPatterns) {
      const match = cleanText.match(pattern);
      if (match) {
        requirements.wordCount = { min: parseInt(match[1]) };
        break;
      }
    }

    // Extract page count
    const pageCountMatch = cleanText.match(/(\d+)[\s-]*page/i);
    if (pageCountMatch) {
      requirements.pageCount = { min: parseInt(pageCountMatch[1]) };
    }

    // Check for citations requirement
    const citationPatterns = [
      /cite/i,
      /citation/i,
      /bibliography/i,
      /references/i,
      /works cited/i,
      /MLA/,
      /APA/,
      /Chicago/,
    ];

    for (const pattern of citationPatterns) {
      if (pattern.test(cleanText)) {
        requirements.citations = true;
        // Try to extract citation style
        if (/MLA/.test(cleanText)) requirements.citationStyle = "MLA";
        else if (/APA/.test(cleanText)) requirements.citationStyle = "APA";
        else if (/Chicago/.test(cleanText)) requirements.citationStyle = "Chicago";
        break;
      }
    }

    // Extract links/resources from HTML
    if (html) {
      const $ = cheerio.load(html);
      $("a").each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().trim();
        if (href && text && !href.startsWith("javascript:")) {
          requirements.resources.push({ text, url: href });
        }
      });
    }

    // Extract rubric-like items (numbered or bulleted lists)
    const listItemPattern = /(?:^|\n)\s*(?:\d+\.|\*|-)\s*([^\n]+)/g;
    let match;
    while ((match = listItemPattern.exec(cleanText)) !== null) {
      const item = match[1].trim();
      if (item.length > 10 && item.length < 200) {
        requirements.rubricItems.push(item);
      }
    }

    // Extract key phrases (things that look like requirements)
    const keyPhrasePatterns = [
      /should\s+(?:have|include|contain|address|discuss|analyze)\s+([^.]+)/gi,
      /must\s+(?:have|include|contain|address|discuss|analyze)\s+([^.]+)/gi,
      /(?:ensure|make sure)\s+(?:that\s+)?([^.]+)/gi,
      /(?:focus on|write about|discuss|analyze)\s+([^.]+)/gi,
    ];

    for (const pattern of keyPhrasePatterns) {
      let match;
      while ((match = pattern.exec(cleanText)) !== null) {
        const phrase = match[1].trim();
        if (phrase.length > 5 && phrase.length < 150) {
          requirements.keyPhrases.push(phrase);
        }
      }
    }

    return requirements;
  }

  private classifyAssignment(assignment: CanvasAssignment, cleanText: string): AssignmentType {
    const name = assignment.name.toLowerCase();
    const desc = cleanText.toLowerCase();
    const types = assignment.submission_types || [];

    // Check submission types first
    if (types.includes("online_quiz")) return "quiz";
    if (types.includes("discussion_topic")) return "discussion";
    if (types.includes("external_tool")) {
      // Check if it's a Gradescope assignment (likely code/homework)
      if (desc.includes("gradescope")) return "homework";
    }

    // Check name patterns
    if (/quiz|exam|test|midterm|final/i.test(name)) return "quiz";
    if (/lab\s*\d|laboratory/i.test(name)) return "lab";
    if (/homework|hw\s*\d|problem\s*set|pset/i.test(name)) return "homework";
    if (/project/i.test(name)) {
      if (/group|team/i.test(name) || /group|team/i.test(desc)) return "group_project";
      return "homework";
    }
    if (/presentation/i.test(name)) return "presentation";
    if (/discussion/i.test(name)) return "discussion";
    if (/attendance|participation/i.test(name)) return "attendance";
    if (/reflection/i.test(name)) return "reflection";
    if (/essay|paper|writing/i.test(name)) return "essay";

    // Check description patterns
    if (/reflection\s*paper|write\s*a\s*reflection/i.test(desc)) return "reflection";
    if (/essay|write\s*a\s*paper|\d+[\s-]*word/i.test(desc)) return "essay";
    if (/implement|code|program|function|class|method|algorithm/i.test(desc)) return "code";
    if (/group\s*project|team\s*project|work\s*together/i.test(desc)) return "group_project";
    if (/present|presentation|slides/i.test(desc)) return "presentation";

    return "unknown";
  }

  private extractSubmissionInfo(assignment: CanvasAssignment): SubmissionInfo {
    const types = assignment.submission_types || [];
    const isExternalTool = types.includes("external_tool");

    return {
      types,
      dueDate: assignment.due_at,
      pointsPossible: assignment.points_possible,
      isExternalTool,
      externalToolName: isExternalTool ? this.detectExternalTool(assignment) : undefined,
    };
  }

  private detectExternalTool(assignment: CanvasAssignment): string | undefined {
    const desc = (assignment.description || "").toLowerCase();
    if (desc.includes("gradescope")) return "Gradescope";
    if (desc.includes("piazza")) return "Piazza";
    if (desc.includes("prairielearn")) return "PrairieLearn";
    if (desc.includes("zybooks")) return "zyBooks";
    return undefined;
  }

  private determineAutomatability(
    type: AssignmentType,
    submission: SubmissionInfo,
    requirements: AssignmentRequirements
  ): { automatable: boolean; reason: string } {
    // Not automatable types
    if (type === "quiz" || type === "exam") {
      return { automatable: false, reason: "Quizzes and exams require real-time responses" };
    }
    if (type === "attendance") {
      return { automatable: false, reason: "Attendance requires physical presence" };
    }
    if (type === "presentation") {
      return { automatable: false, reason: "Presentations require human delivery" };
    }
    if (type === "group_project") {
      return { automatable: false, reason: "Group projects require coordination with team members" };
    }
    if (type === "discussion") {
      return { automatable: false, reason: "Discussions require interactive participation" };
    }

    // Check submission type
    if (submission.types.includes("none")) {
      return { automatable: false, reason: "No submission required" };
    }
    if (submission.types.includes("on_paper")) {
      return { automatable: false, reason: "Requires physical paper submission" };
    }

    // External tools need special handling
    if (submission.isExternalTool) {
      if (submission.externalToolName === "Gradescope") {
        return { automatable: true, reason: "Can submit to Gradescope via API" };
      }
      return { automatable: false, reason: `External tool (${submission.externalToolName || 'unknown'}) not supported` };
    }

    // Automatable types
    if (type === "essay" || type === "reflection") {
      return { automatable: true, reason: "Written assignments can be generated" };
    }
    if (type === "code" || type === "homework" || type === "lab") {
      return { automatable: true, reason: "Code/homework assignments can be completed" };
    }

    // Default
    if (submission.types.includes("online_upload") ||
        submission.types.includes("online_text_entry")) {
      return { automatable: true, reason: "Supports online submission" };
    }

    return { automatable: false, reason: "Unknown submission requirements" };
  }

  // Generate a summary for display
  summarize(analysis: AnalyzedAssignment): string {
    const lines: string[] = [];

    lines.push(`📝 ${analysis.name}`);
    lines.push(`Type: ${analysis.type}`);
    lines.push(`Points: ${analysis.submission.pointsPossible}`);

    if (analysis.submission.dueDate) {
      const due = new Date(analysis.submission.dueDate);
      lines.push(`Due: ${due.toLocaleDateString()} ${due.toLocaleTimeString()}`);
    }

    lines.push(`Automatable: ${analysis.automatable ? "✓ Yes" : "✗ No"} - ${analysis.automatableReason}`);

    if (analysis.requirements.wordCount?.min) {
      lines.push(`Word count: ${analysis.requirements.wordCount.min}+ words`);
    }

    if (analysis.requirements.citations) {
      lines.push(`Citations: Required${analysis.requirements.citationStyle ? ` (${analysis.requirements.citationStyle})` : ""}`);
    }

    if (analysis.requirements.keyPhrases.length > 0) {
      lines.push(`Key requirements:`);
      for (const phrase of analysis.requirements.keyPhrases.slice(0, 3)) {
        lines.push(`  • ${phrase}`);
      }
    }

    if (analysis.requirements.resources.length > 0) {
      lines.push(`Resources: ${analysis.requirements.resources.length} linked`);
    }

    return lines.join("\n");
  }
}
