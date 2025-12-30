import { AnalyzedAssignment, AssignmentType } from "./analyzer.js";

export interface SolutionContext {
  assignmentId: number;
  courseId: number;
  assignmentName: string;
  type: AssignmentType;

  // Generation instructions
  instructions: string;
  format: SolutionFormat;
  constraints: string[];

  // Content guidance
  topics: string[];
  keyPoints: string[];
  resources: ResourceContext[];

  // Requirements
  wordCount?: { min?: number; max?: number };
  citationStyle?: string;
  additionalRequirements: string[];
}

export interface ResourceContext {
  title: string;
  url: string;
  description?: string;
}

export type SolutionFormat = "essay" | "code" | "short_answer" | "file_upload";

export interface Draft {
  id: string;
  assignmentId: number;
  courseId: number;
  assignmentName: string;
  content: string;
  format: SolutionFormat;
  createdAt: Date;
  updatedAt: Date;
  status: "draft" | "ready_for_review" | "approved" | "submitted";
  feedback?: string;
}

export class SolutionGenerator {
  private drafts: Map<string, Draft> = new Map();

  // Prepare context for Claude to generate a solution
  prepareContext(analysis: AnalyzedAssignment): SolutionContext {
    const format = this.determineFormat(analysis);
    const instructions = this.generateInstructions(analysis, format);
    const constraints = this.extractConstraints(analysis);
    const keyPoints = this.extractKeyPoints(analysis);

    return {
      assignmentId: analysis.id,
      courseId: analysis.courseId,
      assignmentName: analysis.name,
      type: analysis.type,
      instructions,
      format,
      constraints,
      topics: analysis.requirements.topics,
      keyPoints,
      resources: analysis.requirements.resources.map((r) => ({
        title: r.text,
        url: r.url,
      })),
      wordCount: analysis.requirements.wordCount,
      citationStyle: analysis.requirements.citationStyle,
      additionalRequirements: analysis.requirements.keyPhrases,
    };
  }

  private determineFormat(analysis: AnalyzedAssignment): SolutionFormat {
    switch (analysis.type) {
      case "essay":
      case "reflection":
        return "essay";
      case "code":
      case "lab":
      case "homework":
        // Check submission types to determine if code or other
        if (analysis.submission.types.includes("online_text_entry")) {
          return "short_answer";
        }
        return "code";
      default:
        if (analysis.submission.types.includes("online_upload")) {
          return "file_upload";
        }
        return "short_answer";
    }
  }

  private generateInstructions(
    analysis: AnalyzedAssignment,
    format: SolutionFormat
  ): string {
    const lines: string[] = [];

    lines.push(`Generate a ${format} solution for the assignment "${analysis.name}".`);
    lines.push("");

    // Add type-specific instructions
    switch (format) {
      case "essay":
        lines.push("ESSAY REQUIREMENTS:");
        lines.push("- Write a well-structured academic essay");
        lines.push("- Include an introduction with a clear thesis statement");
        lines.push("- Develop arguments with supporting evidence");
        lines.push("- Include a conclusion that summarizes key points");
        if (analysis.requirements.wordCount?.min) {
          lines.push(`- Target word count: ${analysis.requirements.wordCount.min}+ words`);
        }
        if (analysis.requirements.citationStyle) {
          lines.push(`- Use ${analysis.requirements.citationStyle} citation format`);
        }
        break;

      case "code":
        lines.push("CODE REQUIREMENTS:");
        lines.push("- Write clean, well-documented code");
        lines.push("- Include comments explaining key logic");
        lines.push("- Follow best practices for the language");
        lines.push("- Handle edge cases appropriately");
        break;

      case "short_answer":
        lines.push("SHORT ANSWER REQUIREMENTS:");
        lines.push("- Provide a clear, concise response");
        lines.push("- Address all parts of the question");
        lines.push("- Support answers with reasoning or evidence");
        break;

      case "file_upload":
        lines.push("FILE SUBMISSION REQUIREMENTS:");
        lines.push("- Generate content suitable for file submission");
        lines.push("- Follow any specified formatting requirements");
        break;
    }

    // Add assignment description context
    if (analysis.cleanDescription) {
      lines.push("");
      lines.push("ASSIGNMENT DESCRIPTION:");
      lines.push(analysis.cleanDescription);
    }

    return lines.join("\n");
  }

  private extractConstraints(analysis: AnalyzedAssignment): string[] {
    const constraints: string[] = [];

    if (analysis.requirements.wordCount?.min) {
      constraints.push(`Minimum ${analysis.requirements.wordCount.min} words`);
    }
    if (analysis.requirements.wordCount?.max) {
      constraints.push(`Maximum ${analysis.requirements.wordCount.max} words`);
    }
    if (analysis.requirements.pageCount?.min) {
      constraints.push(`Minimum ${analysis.requirements.pageCount.min} pages`);
    }
    if (analysis.requirements.citations) {
      constraints.push("Citations required");
    }
    if (analysis.requirements.citationStyle) {
      constraints.push(`Citation style: ${analysis.requirements.citationStyle}`);
    }

    return constraints;
  }

  private extractKeyPoints(analysis: AnalyzedAssignment): string[] {
    const keyPoints: string[] = [];

    // Add rubric items as key points
    keyPoints.push(...analysis.requirements.rubricItems);

    // Add key phrases
    keyPoints.push(...analysis.requirements.keyPhrases);

    return keyPoints;
  }

  // Generate a prompt for Claude to create the solution
  generatePrompt(context: SolutionContext): string {
    const sections: string[] = [];

    // Header
    sections.push("# Assignment Solution Request");
    sections.push("");
    sections.push(`**Assignment:** ${context.assignmentName}`);
    sections.push(`**Type:** ${context.type}`);
    sections.push(`**Format:** ${context.format}`);
    sections.push("");

    // Instructions
    sections.push("## Instructions");
    sections.push(context.instructions);
    sections.push("");

    // Constraints
    if (context.constraints.length > 0) {
      sections.push("## Constraints");
      context.constraints.forEach((c) => sections.push(`- ${c}`));
      sections.push("");
    }

    // Key requirements
    if (context.additionalRequirements.length > 0) {
      sections.push("## Key Requirements");
      context.additionalRequirements.forEach((r) => sections.push(`- ${r}`));
      sections.push("");
    }

    // Key points to address
    if (context.keyPoints.length > 0) {
      sections.push("## Points to Address");
      context.keyPoints.forEach((p) => sections.push(`- ${p}`));
      sections.push("");
    }

    // Resources
    if (context.resources.length > 0) {
      sections.push("## Resources to Reference");
      context.resources.forEach((r) => {
        sections.push(`- [${r.title}](${r.url})`);
      });
      sections.push("");
    }

    // Output format
    sections.push("## Expected Output");
    switch (context.format) {
      case "essay":
        sections.push("Provide a complete essay with:");
        sections.push("1. Title");
        sections.push("2. Introduction with thesis");
        sections.push("3. Body paragraphs with topic sentences");
        sections.push("4. Conclusion");
        if (context.citationStyle) {
          sections.push(`5. Works Cited/References in ${context.citationStyle} format`);
        }
        break;
      case "code":
        sections.push("Provide complete, runnable code with:");
        sections.push("1. Required imports/dependencies");
        sections.push("2. Well-commented implementation");
        sections.push("3. Example usage or test cases");
        break;
      case "short_answer":
        sections.push("Provide a clear, direct answer addressing all parts of the question.");
        break;
      case "file_upload":
        sections.push("Provide content formatted for file submission.");
        break;
    }

    return sections.join("\n");
  }

  // Draft management
  saveDraft(
    assignmentId: number,
    courseId: number,
    assignmentName: string,
    content: string,
    format: SolutionFormat
  ): Draft {
    const id = `${courseId}-${assignmentId}`;
    const now = new Date();

    const existing = this.drafts.get(id);
    const draft: Draft = {
      id,
      assignmentId,
      courseId,
      assignmentName,
      content,
      format,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: "draft",
    };

    this.drafts.set(id, draft);
    return draft;
  }

  getDraft(courseId: number, assignmentId: number): Draft | undefined {
    const id = `${courseId}-${assignmentId}`;
    return this.drafts.get(id);
  }

  getAllDrafts(): Draft[] {
    return Array.from(this.drafts.values());
  }

  updateDraftStatus(
    courseId: number,
    assignmentId: number,
    status: Draft["status"],
    feedback?: string
  ): Draft | undefined {
    const id = `${courseId}-${assignmentId}`;
    const draft = this.drafts.get(id);

    if (draft) {
      draft.status = status;
      draft.updatedAt = new Date();
      if (feedback) {
        draft.feedback = feedback;
      }
      this.drafts.set(id, draft);
    }

    return draft;
  }

  updateDraftContent(
    courseId: number,
    assignmentId: number,
    content: string
  ): Draft | undefined {
    const id = `${courseId}-${assignmentId}`;
    const draft = this.drafts.get(id);

    if (draft) {
      draft.content = content;
      draft.updatedAt = new Date();
      draft.status = "draft"; // Reset to draft when content changes
      this.drafts.set(id, draft);
    }

    return draft;
  }

  deleteDraft(courseId: number, assignmentId: number): boolean {
    const id = `${courseId}-${assignmentId}`;
    return this.drafts.delete(id);
  }

  // Helper to format solution for display
  formatForReview(draft: Draft): string {
    const lines: string[] = [];

    lines.push(`# Draft Review: ${draft.assignmentName}`);
    lines.push("");
    lines.push(`**Status:** ${draft.status}`);
    lines.push(`**Format:** ${draft.format}`);
    lines.push(`**Last Updated:** ${draft.updatedAt.toLocaleString()}`);
    lines.push("");

    if (draft.feedback) {
      lines.push("## Feedback");
      lines.push(draft.feedback);
      lines.push("");
    }

    lines.push("## Content");
    lines.push("```");
    lines.push(draft.content);
    lines.push("```");

    // Word count for essays
    if (draft.format === "essay") {
      const wordCount = draft.content.split(/\s+/).filter((w) => w.length > 0).length;
      lines.push("");
      lines.push(`**Word Count:** ${wordCount}`);
    }

    return lines.join("\n");
  }
}
