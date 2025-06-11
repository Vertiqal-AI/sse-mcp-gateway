#!/usr/bin/env node

import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

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

// --- Child Process Event Handlers ---
mcp.stderr.on("data", (data) => console.error(`MCP stderr: ${data.toString()}`));
mcp.on("close", (code) => console.log(`MCP process exited with code ${code}`));
mcp.on('error', (err) => console.error('Failed to start MCP subprocess.', err));

// --- Setup Express and MCP Server Instance ---
const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.text({ type: "*/*" }));

const mcpServer = new Server(
  { name: "sse-proxy-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- Handle HTTP Endpoints ---
app.get("/sse", async (req, res) => {
  console.log("New SSE connection received.");
  const transport = new SSEServerTransport("/message", res);
  try {
    await mcpServer.connect(transport);
    console.log("SSE transport successfully connected to the server instance.");
  } catch (e) {
    console.error("Error connecting SSE transport:", e);
  }
});

app.post("/message", async (req, res) => {
  if (mcp.stdin.writable) {
    try {
      const singleLineJson = JSON.stringify(JSON.parse(req.body));
      mcp.stdin.write(singleLineJson + "\n");
      res.sendStatus(202);
    } catch (e) {
      res.status(400).send("Invalid JSON");
    }
  } else {
    res.status(500).send("MCP stdin closed");
  }
});

// --- Handle Data from the Child Process ---
// Use a buffer to handle streaming data robustly
let stdoutBuffer = '';
mcp.stdout.on("data", (data) => {
  stdoutBuffer += data.toString();
  let newlineIndex;

  // Process every complete line (ending in a newline) in the buffer
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.substring(0, newlineIndex).trim();
    // Keep the rest of the buffer for the next data chunk
    stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);

    if (line) { // Only process non-empty lines
      try {
        const json = JSON.parse(line);
        mcpServer.broadcast(json);
        console.log("Broadcasting message from MCP to connected clients.");
      } catch (err) {
        console.error("Invalid JSON received from MCP stdout:", line);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP Gateway running at http://localhost:${PORT}/sse`);
});
