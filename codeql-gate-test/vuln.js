"use strict";
// Intentional vulnerability to validate CodeQL merge protection. DO NOT MERGE.
const http = require("http");
const { execSync } = require("child_process");

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, "http://example.com");
  const userInput = parsed.searchParams.get("q");
  // js/command-line-injection: remote user input flows into a shell command
  const out = execSync("grep " + userInput + " /etc/hosts").toString();
  res.end(out);
});

server.listen(8080);
