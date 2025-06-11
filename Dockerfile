# --- Stage 1: Build the Airtable MCP Server ---
# We use a specific Node version and name this stage 'mcp_builder'
FROM node:18-alpine AS mcp_builder

# Install git, which is needed to clone the repo
RUN apk add --no-cache git

# Set the working directory for the MCP server build
WORKDIR /mcp-src

# Clone the original felores airtable-mcp repository
RUN git clone https://github.com/felores/airtable-mcp.git .

# Install ALL dependencies (including dev) and build the final JavaScript
RUN npm install
RUN npm run build


# --- Stage 2: Build the Final Gateway Application ---
# Start from a fresh, clean Node image for our production app
FROM node:18-alpine

# Set the working directory for the gateway app
WORKDIR /app

# Copy over the package.json files first to leverage Docker layer caching
COPY package*.json ./

# Install only the production dependencies for the gateway
RUN npm install --omit=dev

# Copy the rest of our gateway's source code (sse-mcp-gateway.js, etc.)
COPY . .

# --- The Magic Step (Corrected) ---
# Copy the entire pre-built MCP server, including its node_modules and build folder,
# from the 'mcp_builder' stage into our final image.
COPY --from=mcp_builder /mcp-src ./airtable-mcp-src

# The gateway will be listening on port 8080
EXPOSE 8080

# The command to run when the container starts
CMD ["node", "sse-mcp-gateway.js"]
