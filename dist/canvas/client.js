const CANVAS_BASE_URL = "https://bcourses.berkeley.edu";
export class CanvasClient {
    apiToken = null;
    baseUrl = CANVAS_BASE_URL;
    async login(apiToken) {
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
        }
        catch (error) {
            this.apiToken = null;
            return false;
        }
    }
    isLoggedIn() {
        return this.apiToken !== null;
    }
    async getCourses() {
        if (!this.apiToken)
            throw new Error("Not logged in to Canvas");
        const courses = [];
        let url = `${this.baseUrl}/api/v1/courses?per_page=100&enrollment_state=active`;
        while (url) {
            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${this.apiToken}`,
                },
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch courses: ${response.status}`);
            }
            const data = await response.json();
            courses.push(...data);
            const linkHeader = response.headers.get("Link");
            url = null;
            if (linkHeader) {
                const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                if (nextMatch) {
                    url = nextMatch[1];
                }
            }
        }
        return courses;
    }
    async getAssignments(courseId) {
        if (!this.apiToken)
            throw new Error("Not logged in to Canvas");
        const assignments = [];
        let url = `${this.baseUrl}/api/v1/courses/${courseId}/assignments?per_page=100&order_by=due_at`;
        while (url) {
            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${this.apiToken}`,
                },
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch assignments: ${response.status}`);
            }
            const data = await response.json();
            assignments.push(...data);
            const linkHeader = response.headers.get("Link");
            url = null;
            if (linkHeader) {
                const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                if (nextMatch) {
                    url = nextMatch[1];
                }
            }
        }
        return assignments;
    }
    async getAssignment(courseId, assignmentId) {
        if (!this.apiToken)
            throw new Error("Not logged in to Canvas");
        const response = await fetch(`${this.baseUrl}/api/v1/courses/${courseId}/assignments/${assignmentId}`, {
            headers: {
                Authorization: `Bearer ${this.apiToken}`,
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch assignment: ${response.status}`);
        }
        return response.json();
    }
}
