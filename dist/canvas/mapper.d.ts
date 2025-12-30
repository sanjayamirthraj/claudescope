import { CanvasCourse, CanvasAssignment, CourseMapping, AssignmentMapping, GradescopeCourse, GradescopeAssignment } from "./types.js";
export declare class CourseMapper {
    private courseMappings;
    private assignmentMappings;
    autoMatchCourses(canvasCourses: CanvasCourse[], gradescopeCourses: GradescopeCourse[]): {
        matched: CourseMapping[];
        unmatched: CanvasCourse[];
    };
    manualMapCourse(canvasCourse: CanvasCourse, gradescopeCourse: GradescopeCourse): CourseMapping;
    excludeCourse(canvasCourseId: number): boolean;
    includeCourse(canvasCourseId: number): boolean;
    getCourseMappings(): CourseMapping[];
    getActiveCourseMappings(): CourseMapping[];
    getMappingForCanvasCourse(canvasCourseId: number): CourseMapping | undefined;
    autoMatchAssignments(canvasCourseId: number, canvasAssignments: CanvasAssignment[], gradescopeAssignments: GradescopeAssignment[]): {
        matched: AssignmentMapping[];
        unmatched: CanvasAssignment[];
    };
    getAssignmentMappings(canvasCourseId: number): AssignmentMapping[];
    getGradescopeAssignmentId(canvasCourseId: number, canvasAssignmentId: number): string | undefined;
}
