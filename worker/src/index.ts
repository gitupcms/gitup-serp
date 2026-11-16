import { connect } from "cloudflare:sockets";
import { createApp } from "./app.js";

export default createApp(connect);
