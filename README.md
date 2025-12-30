# Gradescope MCP

A Model Context Protocol (MCP) server that integrates Canvas LMS and Gradescope, allowing Claude to help manage coursework, analyze assignments, and submit work.

## Features

- **Canvas Integration**: Connect to Canvas LMS to fetch courses and assignments
- **Gradescope Integration**: Submit assignments and view grades
- **Natural Language Workflow**: Say "complete hw 17 from cs 170" and the system handles the rest
- **Assignment Analysis**: Automatically classifies assignments and extracts requirements
- **Draft Management**: Review solutions before submission
- **Full Logging**: Detailed documentation of all actions

## Installation

```bash
npm install
npm run build
```

## Configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gradescope": {
      "command": "node",
      "args": ["/path/to/gradescope/dist/index.js"]
    }
  }
}
```

## Authentication

### Canvas
1. Go to Canvas → Account → Settings → New Access Token
2. Use `canvas_login` tool with your token

### Gradescope
For SSO/CalNet users:
1. Login to Gradescope in browser
2. Open DevTools → Application → Cookies → gradescope.com
3. Copy `_gradescope_session` and `signed_token` values
4. Use `gradescope_login_with_cookies` with format: `_gradescope_session=xxx; signed_token=yyy`

## Usage

### Quick Start (Natural Language)

```
"complete hw 17 from cs 170"
```

This will:
1. Find the course matching "cs 170"
2. Find assignment matching "hw 17"
3. Analyze the assignment
4. Return a solution prompt
5. Save your solution as a draft
6. Submit to Gradescope after approval

### Step-by-Step Workflow

1. **Setup** (one-time):
   ```
   canvas_login(api_token)
   gradescope_login_with_cookies(cookies)
   auto_match_courses()
   ```

2. **Start assignment**:
   ```
   start_assignment("lab 3 from eecs 16a")
   ```

3. **Save solution for review**:
   ```
   save_and_review(session_id, content)
   ```

4. **Approve and submit**:
   ```
   approve_draft(course_id, assignment_id)
   submit_assignment(session_id)
   ```

## Available Tools

### Gradescope Tools
| Tool | Description |
|------|-------------|
| `gradescope_login` | Login with email/password |
| `gradescope_login_with_cookies` | Login with browser cookies (SSO) |
| `gradescope_get_courses` | List all courses |
| `gradescope_get_assignments` | List assignments for a course |
| `gradescope_get_grades` | Get grades for a course |
| `gradescope_upload_submission` | Upload files to an assignment |

### Canvas Tools
| Tool | Description |
|------|-------------|
| `canvas_login` | Login with API token |
| `canvas_get_courses` | List all courses |
| `canvas_get_assignments` | List assignments for a course |
| `canvas_get_assignment` | Get assignment details |

### Course Mapping Tools
| Tool | Description |
|------|-------------|
| `auto_match_courses` | Match Canvas courses to Gradescope |
| `get_course_mappings` | View current mappings |
| `exclude_course` | Exclude a course from automation |
| `include_course` | Re-include an excluded course |
| `auto_match_assignments` | Match assignments for a course |
| `get_assignment_mappings` | View assignment mappings |

### Assignment Analysis Tools
| Tool | Description |
|------|-------------|
| `analyze_assignment` | Analyze a single assignment |
| `analyze_course_assignments` | Analyze all assignments in a course |

### Solution & Draft Tools
| Tool | Description |
|------|-------------|
| `prepare_solution` | Get solution prompt for an assignment |
| `save_draft` | Save solution as draft |
| `get_draft` | Retrieve a draft |
| `list_drafts` | List all drafts |
| `update_draft` | Update draft content |
| `approve_draft` | Mark draft ready for submission |
| `delete_draft` | Delete a draft |

### Workflow Tools
| Tool | Description |
|------|-------------|
| `start_assignment` | Start workflow with natural language |
| `save_and_review` | Save solution and prepare for review |
| `submit_assignment` | Submit approved assignment |
| `get_workflow_status` | Check workflow session status |
| `list_workflows` | List all workflow sessions |
| `get_workflow_documentation` | Get full report for a session |

## Natural Language Formats

The `start_assignment` tool understands:
- `"hw 17 from cs 170"`
- `"complete lab 3 for eecs 16a"`
- `"reflection 2 from astro 9"`
- `"cs 61b homework 5"`

## Assignment Types

The analyzer classifies assignments as:
- `essay` / `reflection` - Written assignments
- `code` / `lab` / `homework` - Programming assignments
- `quiz` / `exam` - Not automatable
- `presentation` / `group_project` - Not automatable
- `discussion` / `attendance` - Not automatable

## Project Structure

```
src/
├── index.ts              # Main MCP server with all tools
└── canvas/
    ├── types.ts          # Shared type definitions
    ├── client.ts         # Canvas API client
    ├── mapper.ts         # Course/assignment matching
    ├── analyzer.ts       # Assignment classification
    ├── generator.ts      # Solution prompts & drafts
    └── orchestrator.ts   # Workflow & logging
```

## License

MIT
