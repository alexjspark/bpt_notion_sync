export function activeTrainerId(): string {
  return process.env.ACTIVE_TRAINER_ID || 'trainer-demo';
}

export function allowedOrigin(request: Request): string {
  void request;
  return process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:4310';
}

export function safeJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
