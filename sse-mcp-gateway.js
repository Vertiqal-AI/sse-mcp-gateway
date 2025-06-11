#!/usr/bin/env node

import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

dotenv.config();

// --- API Key Validation ---
let cleanApiKey = '';
const dirtyApiKey = process.env.AIRTABLE_API_KEY || '';
if (dirtyApiKey && dirtyApiKey.includes('pat')) {
  cleanApiKey = dirtyApiKey.substring(dirtyApiKey.indexOf('pat'));
  console.log(`✅ API Key Loaded and Cleaned.`);
} else {
  console.error('❌ FATAL: AIRTABLE_API_KEY is not defined or is invalid! Please set it in Railway.');
  process.exit(1);
}

// --- Spawn MCP Server ---
const command = 'node';
const mcpScriptPath = './airtable-mcp-src/build/index.js';
const args = [ mcpScriptPath ];
console.log(`Spawning MCP process with command: ${command} ${args[0]}`);

const mcp = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, 'AIRTABLE_API_KEY': cleanApiKey }
});

// Listen for errors from the MCP process
mcp.stderr.on("data", (data) => {
  console.error(`MCP stderr: ${data.toString()}`);
});

// Listen for when the MCP process closes
mcp.on("close", (code) => {
  console.log(`MCP process exited with code ${code}`);
});

// Listen for spawn errors (e.g., command not found)
mcp.on('error', (err) => {
  console.error('Failed to start MCP subprocess.', err);
});

// 3. Setup Express and SSE transport
const app = express();
const PORT = process.env.PORT || 8808;
app.use(cors());
app.use(express.text({ type: "*/*" }));

let transport;

const server = new Server(
  { name: "GenericMCP-Gateway", version: "0.1.0" },
  {
    capabilities: {
      resources: {},
      tools: {},
      templates: {},
    },
  }
);

// 4. Forward stdout → SSE
mcp.stdout.on("data", (data) => {
  console.log(`Received data from MCP stdout: ${data.toString()}`); // Added for logging
  const lines = data.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      // Normalize content format
      if (json.result?.content) {
        const rawContent = Array.isArray(json.result.content)
          ? json.result.content
          : [json.result.content];

        const joinedText = rawContent.map((entry) => {
          if (typeof entry === "string") {
            try {
              const parsed = JSON.parse(entry);
              return JSON.stringify(parsed, null, 2);
            } catch {
              return entry;
            }
          }

          if (typeof entry === "object" && typeof entry.text === "string") {
            return entry.text;
          }

          return JSON.stringify(entry, null, 2);
        }).join("\n\n");

        json.result.content = "```\n" + joinedText + "\n```";
      }

      transport?.send(json);
    } catch (err) {
      console.error("Invalid JSON from MCP:", line);
    }
  }
});

// 5. Define HTTP endpoints
app.get("/sse", async (req, res) => {
  console.log("New SSE connection.");
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  if (mcp.stdin.writable) {
    console.log(`Writing to MCP stdin: ${req.body}`);
    const singleLineJson = JSON.stringify(JSON.parse(req.body));
    mcp.stdin.write(singleLineJson + "\n");
    res.sendStatus(202);
  } else {
    console.error("Attempted to write to a closed MCP stdin.");
    res.status(500).send("MCP stdin closed");
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP Gateway running at http://localhost:${PORT}/sse`);
});
