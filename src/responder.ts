import { PASSWORD_KEY, USERNAME_KEY } from "./constants";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, POST",

  "Access-Control-Allow-Headers": [
    "Content-Type",
    USERNAME_KEY,
    PASSWORD_KEY,
  ].join(", "),
};

type Options = {
  status?: number;
  headers?: Record<string, string>;
};

export function response(
  content: string | any,
  { headers, status }: Options = {}
) {
  const stringContent =
    typeof content !== "string" ? JSON.stringify(content) : content;

  return new Response(stringContent, {
    status,
    headers: {
      ...HEADERS,
      ...headers,
    },
  });
}

/**
 * @description Returns a 200 response, with the data passed in the body
 */
export function ok(data: any, options?: Options) {
  const result = {
    success: true,
    data,
  };

  return response(result, options);
}

/**
 * @description Returns a 500 response, with the error message passed in the body
 */
export function nok(error: string, options?: Options) {
  const result = {
    success: false,
    error,
  };

  return response(result, options);
}
