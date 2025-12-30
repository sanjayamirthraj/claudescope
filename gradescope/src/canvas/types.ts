export interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  enrollment_term_id: number;
  workflow_state: string;
}

export interface CanvasAssignment {
  id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  points_possible: number;
  submission_types: string[];
  html_url: string;
  has_submitted_submissions: boolean;
}

export interface CourseMapping {
  canvasCourseId: number;
  canvasCourseName: string;
  gradescopeCourseId: string;
  gradescopeCourseName: string;
  excluded: boolean;
}

export interface AssignmentMapping {
  canvasAssignmentId: number;
  canvasAssignmentName: string;
  gradescopeAssignmentId: string;
  gradescopeAssignmentName: string;
}

// Gradescope types (for mapping purposes)
export interface GradescopeCourse {
  id: string;
  name: string;
  shortName: string;
  term: string;
  role: string;
}

export interface GradescopeAssignment {
  id: string;
  name: string;
  dueDate: string;
  status: string;
  score: string;
}
