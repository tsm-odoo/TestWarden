function buildRPCPayload(params?: object) {
  return {
    jsonrpc: "2.0",
    method: "call",
    params: params || {},
  };
}

async function makeRPC(route: string, params?: object, headers?: Record<string, string>) {
  headers = headers || {};
  headers["Content-Type"] = "application/json";
  const response = await fetch(route, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRPCPayload(params)),
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`RPC request failed with status ${response.status}`);
  }
  return response.json();
}

export async function authenticate(url: string, login: string, password: string): Promise<AuthCookie> {
  const databaseList = await makeRPC(`${url}/web/database/list`);
  const db_name = databaseList.result[0];

  const response = await fetch(`${url}/web/session/authenticate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildRPCPayload({ login, password, db: db_name })),
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Authentication failed with status ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Authentication failed for user ${login} with password ${password}`);
  }
  return {
    name: "session_id",
    value: setCookie.split(";")[0].split("=")[1],
    domain: url.split("//")[1].split(":")[0],
    path: "/",
  };
}
