import { CanvasCourse, CanvasAssignment } from "./types.js";
export declare class CanvasClient {
    private apiToken;
    private baseUrl;
    login(apiToken: string): Promise<boolean>;
    isLoggedIn(): boolean;
    getCourses(): Promise<CanvasCourse[]>;
    getAssignments(courseId: number): Promise<CanvasAssignment[]>;
    getAssignment(courseId: number, assignmentId: number): Promise<CanvasAssignment>;
}
