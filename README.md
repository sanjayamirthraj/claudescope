# Claudescope

A Model Context Protocol (MCP) server that integrates Canvas LMS and Gradescope.

## Claude Desktop Config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gradescope": {
      "command": "node",
      "args": ["/path/to/claudescope/gradescope/dist/index.js"],
      "env": {
        "CANVAS_API_TOKEN": "your_canvas_api_token",
        "GRADESCOPE_SESSION": "your_gradescope_session_cookie",
        "GRADESCOPE_TOKEN": "your_gradescope_signed_token"
      }
    }
  }
}
```

Get cookies from browser DevTools: Application > Cookies > gradescope.com (`_gradescope_session` and `signed_token`).
