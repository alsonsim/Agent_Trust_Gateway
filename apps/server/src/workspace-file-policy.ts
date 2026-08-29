import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type WorkspaceFileReasonCode =
  | "WORKSPACE_PATH_ALLOWED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PROTECTED_SECRET_FILE"
  | "FILE_TOO_LARGE";

export interface WorkspaceFilePolicyDecision {
  allowed: boolean;
  reasonCode: WorkspaceFileReasonCode;
  reason: string;
  targetLabel: string;
  resolvedPath: string | null;
}

export class WorkspaceFileNotFoundError extends Error {
  constructor() {
    super("Workspace file not found");
    this.name = "WorkspaceFileNotFoundError";
  }
}

const MAX_READ_BYTES = 256 * 1024;
const protectedDirectoryNames = new Set([".aws", ".kube", ".ssh", "secrets"]);
const protectedFileNames = new Set([
  ".gitignore",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_rsa",
]);

export async function evaluateWorkspaceFileRead(
  workspacePath: string,
  requestedPath: string,
): Promise<WorkspaceFilePolicyDecision> {
  return evaluateWorkspaceFilePath(workspacePath, requestedPath, false);
}

export async function evaluateWorkspaceFileWrite(
  workspacePath: string,
  requestedPath: string,
): Promise<WorkspaceFilePolicyDecision> {
  return evaluateWorkspaceFilePath(workspacePath, requestedPath, true);
}

async function evaluateWorkspaceFilePath(
  workspacePath: string,
  requestedPath: string,
  allowMissingTarget: boolean,
): Promise<WorkspaceFilePolicyDecision> {
  const targetLabel = safeTargetLabel(requestedPath);
  if (requestedPath.includes("\0")) {
    return deny(
      "PATH_OUTSIDE_WORKSPACE",
      "The requested path contains an invalid null byte.",
      targetLabel,
    );
  }

  const workspaceRoot = await realpath(workspacePath);
  const candidate = path.resolve(workspaceRoot, requestedPath);
  if (!isInside(workspaceRoot, candidate)) {
    return deny(
      "PATH_OUTSIDE_WORKSPACE",
      "The requested file is outside the Agent workspace.",
      targetLabel,
    );
  }

  const requestedRelativePath = path.relative(workspaceRoot, candidate);
  if (isProtectedPath(requestedRelativePath)) {
    return {
      allowed: false,
      reasonCode: "PROTECTED_SECRET_FILE",
      reason: "Protected configuration and credential files cannot be read by this Agent.",
      targetLabel,
      resolvedPath: null,
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (allowMissingTarget) {
        return evaluateMissingWriteTarget(workspaceRoot, candidate, targetLabel);
      }
      throw new WorkspaceFileNotFoundError();
    }
    throw error;
  }

  if (!isInside(workspaceRoot, canonicalPath)) {
    return deny(
      "PATH_OUTSIDE_WORKSPACE",
      "The requested file resolves outside the Agent workspace.",
      targetLabel,
    );
  }
  const canonicalRelativePath = path.relative(workspaceRoot, canonicalPath);
  if (isProtectedPath(canonicalRelativePath)) {
    return deny(
      "PROTECTED_SECRET_FILE",
      "Protected configuration and credential files cannot be read by this Agent.",
      targetLabel,
    );
  }

  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) throw new WorkspaceFileNotFoundError();
  if (fileStat.size > MAX_READ_BYTES) {
    return deny(
      "FILE_TOO_LARGE",
      "The requested file exceeds the 256 KiB middleware read limit.",
      targetLabel,
    );
  }

  return {
    allowed: true,
    reasonCode: "WORKSPACE_PATH_ALLOWED",
    reason: "The file is inside the Agent workspace and is not protected.",
    targetLabel,
    resolvedPath: canonicalPath,
  };
}

async function evaluateMissingWriteTarget(
  workspaceRoot: string,
  candidate: string,
  targetLabel: string,
): Promise<WorkspaceFilePolicyDecision> {
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(path.dirname(candidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceFileNotFoundError();
    }
    throw error;
  }
  if (!isInside(workspaceRoot, canonicalParent)) {
    return deny(
      "PATH_OUTSIDE_WORKSPACE",
      "The requested file resolves outside the Agent workspace.",
      targetLabel,
    );
  }
  if (isProtectedPath(path.relative(workspaceRoot, canonicalParent))) {
    return deny(
      "PROTECTED_SECRET_FILE",
      "Protected configuration and credential files cannot be read by this Agent.",
      targetLabel,
    );
  }
  return {
    allowed: true,
    reasonCode: "WORKSPACE_PATH_ALLOWED",
    reason: "The file is inside the Agent workspace and is not protected.",
    targetLabel,
    resolvedPath: candidate,
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function isProtectedPath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    return (
      lower === ".env" ||
      lower.startsWith(".env.") ||
      protectedDirectoryNames.has(lower) ||
      protectedFileNames.has(lower) ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key")
    );
  });
}

function safeTargetLabel(requestedPath: string): string {
  const portablePath = requestedPath.replaceAll("\\", "/").replace(/[\r\n\t]/g, " ");
  const normalized = path.posix.normalize(portablePath).replace(/^\.\//, "");
  return normalized.slice(0, 200) || "(empty path)";
}

function deny(
  reasonCode: Exclude<WorkspaceFileReasonCode, "WORKSPACE_PATH_ALLOWED">,
  reason: string,
  targetLabel: string,
): WorkspaceFilePolicyDecision {
  return { allowed: false, reasonCode, reason, targetLabel, resolvedPath: null };
}
