#!/usr/bin/env node

import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Load environment variables from Railway's variable manager
dotenv.config();

// --- API Key Cleaning and Validation ---
let cleanApiKey = '';
const dirtyApiKey = process.env.AIRTABLE_API_KEY || '';

if (dirtyApiKey) {
  const patIndex = dirtyApiKey.indexOf('pat');
  if (patIndex !== -1) {
    cleanApiKey = dirtyApiKey.substring(patIndex);
    console.log(`✅ API Key Loaded and Cleaned.`);
  } else {
    console.error(`❌ FATAL: Could not find 'pat...' sequence in AIRTABLE_API_KEY.`);
    process.exit(1);
  }
} else {
  console.error('❌ FATAL: AIRTABLE_API_KEY is NOT DEFINED in environment! Please set it in Railway.');
  process.exit(1);
}

// --- Define the command to run the pre-built MCP server ---
const command = 'node';
const mcpScriptPath = './airtable-mcp-src/build/index.js';
const args = [ mcpScriptPath ];

console.log(`Spawning MCP process with command: ${command} ${args[0]}`);

const mcp = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    'AIRTABLE_API_KEY': cleanApiKey
  }
});

// --- Enhanced Child Process Debugging ---
mcp.stderr.on("data", (data) => {
  // The MCP server prints its "running" message to stderr, so this is important
  console.error(`[DEBUG] MCP stderr: ${data.toString()}`);
});

mcp.on("close", (code) => {
  console.log(`[DEBUG] MCP process exited with code ${code}`);
});

mcp.on('error', (err) => {
  console.error('[DEBUG] Failed to start MCP subprocess.', err);
});
// -----------------------------------------


// --- Setup Express and SSE transport ---
const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.text({ type: "*/*" }));

let transport;

app.get("/sse", (req, res) => {
  console.log("[DEBUG] A client is connecting to /sse...");
  transport = new SSEServerTransport("/message", res);
  console.log("[DEBUG] SSE transport object created. Ready to send data to client.");
  
  // Keep connection alive
  req.on('close', () => {
    console.log("[DEBUG] SSE client disconnected.");
    transport = null; // Clear the transport when client disconnects
  });
});

app.post("/message", async (req, res) => {
  console.log("[DEBUG] Received POST to /message with body:", req.body);
  if (mcp.stdin.writable) {
    try {
        const singleLineJson = JSON.stringify(JSON.parse(req.body));
        console.log("[DEBUG] Writing to MCP stdin:", singleLineJson);
        mcp.stdin.write(singleLineJson + "\n");
        res.sendStatus(202);
    } catch(e) {
        console.error("[DEBUG] Error parsing JSON in /message:", e.message);
        res.status(400).send("Invalid JSON");
    }
  } else {
    console.error("[DEBUG] Attempted to write to MCP stdin, but it was closed.");
    res.status(500).send("MCP stdin closed");
  }
});

// This is the most important handler for seeing results
mcp.stdout.on("data", (data) => {
  console.log(`[DEBUG] Received data from MCP stdout:\n${data.toString()}`);
  
  // Check if a client is connected before trying to send
  if (transport) {
    console.log("[DEBUG] SSE client is connected. Forwarding data...");
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        transport.send(json);
      } catch (err) {
        console.error("[DEBUG] Error parsing JSON from MCP stdout:", line);
      }
    }
  } else {
    console.warn("[DEBUG] Received data from MCP, but NO SSE client is connected. Data was dropped.");
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP Gateway running at http://localhost:${PORT}/sse`);
});
