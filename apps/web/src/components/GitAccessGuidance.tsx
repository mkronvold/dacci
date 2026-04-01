interface GitAccessGuidanceProps {
  className?: string;
}

export function GitAccessGuidance(props: GitAccessGuidanceProps) {
  return (
    <p className={props.className ?? "muted"}>
      Dacci reads the selected repository's Git remote from its own <code>.git/config</code> and uses the container's
      staged copy of the host <code>~/.ssh</code> configuration plus any forwarded <code>ssh-agent</code> socket for
      pull, push, and refresh. Make sure the same remote already works from this machine first.
    </p>
  );
}

export function isLikelyGitAuthenticationError(message: string | null | undefined): boolean {
  const normalizedMessage = message?.toLowerCase() ?? "";
  if (!normalizedMessage) {
    return false;
  }

  return [
    "permission denied",
    "publickey",
    "authentication failed",
    "repository not found",
    "could not read from remote repository",
    "could not resolve hostname",
    "access denied",
    "could not read username",
  ].some((entry) => normalizedMessage.includes(entry));
}
