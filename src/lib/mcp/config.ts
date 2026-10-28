/**
 * Public origin used for MCP brief links. A constant (overridable by env) keeps a judge
 * on the public demo URL even when the tool is reached through a deployment hostname.
 */
export const PUBLIC_BASE_URL = (
  process.env.DROPQ_PUBLIC_URL?.trim() || "https://dropq.focampo.com"
).replace(/\/+$/, "");
