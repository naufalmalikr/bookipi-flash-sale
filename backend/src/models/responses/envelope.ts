export interface ErrorEnvelope {
  error: string;
  message: string;
}

export function envelope(error: string, message: string): ErrorEnvelope {
  return { error, message };
}
