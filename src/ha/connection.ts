import {
  createConnection,
  createLongLivedTokenAuth,
  type Connection,
} from "home-assistant-js-websocket";

export async function connect(url: string, token: string): Promise<Connection> {
  // Strip trailing slash
  const baseUrl = url.replace(/\/+$/, "");
  const auth = createLongLivedTokenAuth(baseUrl, token);
  const connection = await createConnection({ auth });
  return connection;
}
