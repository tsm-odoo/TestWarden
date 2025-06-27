import axios from "axios";

function buildRPCPayload(params?: object) {
  return {
    jsonrpc: "2.0",
    method: "call",
    params: params || {},
  };
}

async function makeRPC(route: string, params?: object, headers?: object) {
  headers = headers || {};
  headers["Content-type"] = "application/json";

  const response = await axios.post(route, buildRPCPayload(params), {
    headers: headers,
    withCredentials: true,
    data: buildRPCPayload(params),
  });
  return response.data;
}

export async function authenticate(url: string, login: string, password: string): Promise<AuthCookie> {
  const databaseList = await makeRPC(`${url}/web/database/list`);
  const db_name = databaseList.result[0];
  const headers = {
    "Content-type": "application/json",
  };
  const response = await axios.post(
    `${url}/web/session/authenticate`,
    buildRPCPayload({ login: login, password: password, db: db_name }),
    {
      headers: headers,
      withCredentials: true,
    },
  );
  if (!response.headers?.["set-cookie"]) {
    throw new Error(`Authentication failed for user ${login} with password ${password}`);
  }
  return {
    name: "session_id",
    value: response.headers["set-cookie"][0].split(";")[0].split("=")[1],
    domain: url.split("//")[1].split(":")[0],
    path: "/",
  };
}
