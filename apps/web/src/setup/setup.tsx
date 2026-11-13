import { CopyValue } from "../shell/copy-button";

const SETUP_LINK_COMMAND = "docker compose exec api server setup-link";

export function SetupLinkCommand() {
  return <CopyValue label="setup command" value={SETUP_LINK_COMMAND} />;
}
