// The agent's identity, written once. GET /, GET /health and the agent's own
// system prompt answer with API_NAME, so a deploy's smoke, an operator's curl
// and the bootstrap's probe all see which agent answered. The Orun bootstrap
// that creates a product rewrites it to that product's name, so keep it
// literal and on one line.
export const API_NAME = "Personal Ai Agent"
