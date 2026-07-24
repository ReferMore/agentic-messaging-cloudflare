// Matches the platform-wide response envelope: { success: 1|0, message, data }.
// `c: any` mirrors the main API helper and avoids Hono status-code type friction.
export const responseError = (c: any, message: string, statusCode = 400) =>
  c.json({ success: 0, message, data: {} }, statusCode);

export const responseSuccess = (c: any, message: string, data: unknown, statusCode = 200) =>
  c.json({ success: 1, message, data }, statusCode);
