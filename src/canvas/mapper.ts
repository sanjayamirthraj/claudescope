import {
  CanvasCourse,
  CanvasAssignment,
  CourseMapping,
  AssignmentMapping,
  GradescopeCourse,
  GradescopeAssignment,
} from "./types.js";

// Simple string similarity for fuzzy matching (Levenshtein-based)
function stringSimilarity(s1: string, s2: string): number {
  const str1 = s1.toLowerCase().replace(/[^a-z0-9]/g, "");
  const str2 = s2.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;

  // Check if one contains the other
  if (str1.includes(str2) || str2.includes(str1)) {
    return 0.8;
  }

  // Levenshtein distance based similarity
  const matrix: number[][] = [];
  for (let i = 0; i <= str1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str2.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str1.length; i++) {
    for (let j = 1; j <= str2.length; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const maxLen = Math.max(str1.length, str2.length);
  return 1 - matrix[str1.length][str2.length] / maxLen;
}

export class CourseMapper {
  private courseMappings: CourseMapping[] = [];
  private assignmentMappings: Map<string, AssignmentMapping[]> = new Map();

  // Auto-match Canvas courses to Gradescope courses
  autoMatchCourses(
    canvasCourses: CanvasCourse[],
    gradescopeCourses: GradescopeCourse[]
  ): { matched: CourseMapping[]; unmatched: CanvasCourse[] } {
    const matched: CourseMapping[] = [];
    const unmatched: CanvasCourse[] = [];
    const usedGradescopeIds = new Set<string>();

    for (const canvasCourse of canvasCourses) {
      let bestMatch: GradescopeCourse | null = null;
      let bestScore = 0;

      for (const gseCourse of gradescopeCourses) {
        if (usedGradescopeIds.has(gseCourse.id)) continue;

        // Compare course name and code
        const nameScore = stringSimilarity(canvasCourse.name, gseCourse.name);
        const codeScore = stringSimilarity(
          canvasCourse.course_code,
          gseCourse.shortName
        );
        const score = Math.max(nameScore, codeScore);

        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestMatch = gseCourse;
        }
      }

      if (bestMatch) {
        matched.push({
          canvasCourseId: canvasCourse.id,
          canvasCourseName: canvasCourse.name,
          gradescopeCourseId: bestMatch.id,
          gradescopeCourseName: bestMatch.name,
          excluded: false,
        });
        usedGradescopeIds.add(bestMatch.id);
      } else {
        unmatched.push(canvasCourse);
      }
    }

    // Store the mappings
    this.courseMappings = matched;
    return { matched, unmatched };
  }

  // Manually map a Canvas course to a Gradescope course
  manualMapCourse(
    canvasCourse: CanvasCourse,
    gradescopeCourse: GradescopeCourse
  ): CourseMapping {
    // Remove any existing mapping for this Canvas course
    this.courseMappings = this.courseMappings.filter(
      (m) => m.canvasCourseId !== canvasCourse.id
    );

    const mapping: CourseMapping = {
      canvasCourseId: canvasCourse.id,
      canvasCourseName: canvasCourse.name,
      gradescopeCourseId: gradescopeCourse.id,
      gradescopeCourseName: gradescopeCourse.name,
      excluded: false,
    };

    this.courseMappings.push(mapping);
    return mapping;
  }

  // Exclude a course from automation
  excludeCourse(canvasCourseId: number): boolean {
    const mapping = this.courseMappings.find(
      (m) => m.canvasCourseId === canvasCourseId
    );
    if (mapping) {
      mapping.excluded = true;
      return true;
    }
    return false;
  }

  // Include a previously excluded course
  includeCourse(canvasCourseId: number): boolean {
    const mapping = this.courseMappings.find(
      (m) => m.canvasCourseId === canvasCourseId
    );
    if (mapping) {
      mapping.excluded = false;
      return true;
    }
    return false;
  }

  // Get all course mappings
  getCourseMappings(): CourseMapping[] {
    return this.courseMappings;
  }

  // Get non-excluded course mappings
  getActiveCourseMappings(): CourseMapping[] {
    return this.courseMappings.filter((m) => !m.excluded);
  }

  // Get mapping for a specific Canvas course
  getMappingForCanvasCourse(canvasCourseId: number): CourseMapping | undefined {
    return this.courseMappings.find((m) => m.canvasCourseId === canvasCourseId);
  }

  // Auto-match assignments between a mapped course pair
  autoMatchAssignments(
    canvasCourseId: number,
    canvasAssignments: CanvasAssignment[],
    gradescopeAssignments: GradescopeAssignment[]
  ): { matched: AssignmentMapping[]; unmatched: CanvasAssignment[] } {
    const matched: AssignmentMapping[] = [];
    const unmatched: CanvasAssignment[] = [];
    const usedGradescopeIds = new Set<string>();

    for (const canvasAssignment of canvasAssignments) {
      let bestMatch: GradescopeAssignment | null = null;
      let bestScore = 0;

      for (const gsAssignment of gradescopeAssignments) {
        if (usedGradescopeIds.has(gsAssignment.id)) continue;

        const score = stringSimilarity(
          canvasAssignment.name,
          gsAssignment.name
        );

        if (score > bestScore && score >= 0.4) {
          bestScore = score;
          bestMatch = gsAssignment;
        }
      }

      if (bestMatch) {
        matched.push({
          canvasAssignmentId: canvasAssignment.id,
          canvasAssignmentName: canvasAssignment.name,
          gradescopeAssignmentId: bestMatch.id,
          gradescopeAssignmentName: bestMatch.name,
        });
        usedGradescopeIds.add(bestMatch.id);
      } else {
        unmatched.push(canvasAssignment);
      }
    }

    // Store the assignment mappings
    this.assignmentMappings.set(String(canvasCourseId), matched);
    return { matched, unmatched };
  }

  // Get assignment mappings for a course
  getAssignmentMappings(canvasCourseId: number): AssignmentMapping[] {
    return this.assignmentMappings.get(String(canvasCourseId)) || [];
  }

  // Get Gradescope assignment ID for a Canvas assignment
  getGradescopeAssignmentId(
    canvasCourseId: number,
    canvasAssignmentId: number
  ): string | undefined {
    const mappings = this.assignmentMappings.get(String(canvasCourseId));
    if (!mappings) return undefined;
    const mapping = mappings.find(
      (m) => m.canvasAssignmentId === canvasAssignmentId
    );
    return mapping?.gradescopeAssignmentId;
  }
}
