import { CanvasCourse, CanvasAssignment } from "./types.js";

const CANVAS_BASE_URL = "https://bcourses.berkeley.edu";

export class CanvasClient {
  private apiToken: string | null = null;
  private baseUrl: string = CANVAS_BASE_URL;

  async login(apiToken: string): Promise<boolean> {
    this.apiToken = apiToken;

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/users/self`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      if (response.ok) {
        return true;
      }

      this.apiToken = null;
      return false;
    } catch (error) {
      this.apiToken = null;
      return false;
    }
  }

  isLoggedIn(): boolean {
    return this.apiToken !== null;
  }

  async getCourses(): Promise<CanvasCourse[]> {
    if (!this.apiToken) throw new Error("Not logged in to Canvas");

    const courses: CanvasCourse[] = [];
    let url: string | null = `${this.baseUrl}/api/v1/courses?per_page=100&enrollment_state=active`;

    while (url) {
      const response: Response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch courses: ${response.status}`);
      }

      const data = await response.json();
      courses.push(...data);

      const linkHeader: string | null = response.headers.get("Link");
      url = null;
      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          url = nextMatch[1];
        }
      }
    }

    return courses;
  }

  async getAssignments(courseId: number): Promise<CanvasAssignment[]> {
    if (!this.apiToken) throw new Error("Not logged in to Canvas");

    const assignments: CanvasAssignment[] = [];
    let url: string | null = `${this.baseUrl}/api/v1/courses/${courseId}/assignments?per_page=100&order_by=due_at`;

    while (url) {
      const response: Response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch assignments: ${response.status}`);
      }

      const data = await response.json();
      assignments.push(...data);

      const linkHeader: string | null = response.headers.get("Link");
      url = null;
      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          url = nextMatch[1];
        }
      }
    }

    return assignments;
  }

  async getAssignment(courseId: number, assignmentId: number): Promise<CanvasAssignment> {
    if (!this.apiToken) throw new Error("Not logged in to Canvas");

    const response = await fetch(
      `${this.baseUrl}/api/v1/courses/${courseId}/assignments/${assignmentId}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch assignment: ${response.status}`);
    }

    return response.json();
  }
}
