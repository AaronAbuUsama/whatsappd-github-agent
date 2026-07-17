import type { OperationIdentity } from "../capabilities/issue-management/issue-repository.ts";

const FOOTER_START = "<!-- ambience-operation-footer:v1 -->";
const FOOTER_END = "<!-- /ambience-operation-footer -->";
const MARKER_SOURCE = "<!-- ambience-operation:[^\\r\\n]+ -->";
const markerPattern = new RegExp(MARKER_SOURCE, "g");
const exactMarkerPattern = new RegExp(`^${MARKER_SOURCE}$`);
const footerPattern = new RegExp(
  `\\n\\n${FOOTER_START}\\n(${MARKER_SOURCE}(?:\\n${MARKER_SOURCE})*)\\n${FOOTER_END}$`,
);
const legacyUuidMarkerSource =
  "<!-- ambience-operation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->";
const legacyFooterPattern = new RegExp(`(?:\\n\\n${legacyUuidMarkerSource})+$`, "i");
const reservedSyntaxPattern = /<!--\s*\/?\s*ambience-operation(?:-footer)?(?::|\s|-->)/i;

export interface IssueProviderBodyParts {
  readonly publicBody: string;
  readonly markers: readonly string[];
}

export const issueOperationMarker = ({ id }: OperationIdentity): string => `<!-- ambience-operation:${id} -->`;

export const parseIssueProviderBody = (body: string): IssueProviderBodyParts => {
  const footer = body.match(footerPattern);
  if (footer !== null) {
    return {
      publicBody: body.slice(0, -footer[0].length),
      markers: footer[1]?.match(markerPattern) ?? [],
    };
  }

  // Before the owned footer existed, production operation IDs were UUIDs
  // appended as trailing marker paragraphs. Recognize only that narrow legacy
  // shape; marker-looking user text elsewhere remains public.
  const legacyFooter = body.match(legacyFooterPattern);
  if (legacyFooter !== null) {
    return {
      publicBody: body.slice(0, -legacyFooter[0].length),
      markers: legacyFooter[0].match(markerPattern) ?? [],
    };
  }

  return { publicBody: body, markers: [] };
};

const operationProviderBody = (
  resource: "issue" | "comment",
  body: string,
  markers: readonly string[],
  limit: number,
): string => {
  if (reservedSyntaxPattern.test(body)) {
    throw new Error(`The public GitHub ${resource} body contains reserved Ambient Agent Operation Identity syntax.`);
  }
  if (markers.some((marker) => !exactMarkerPattern.test(marker))) {
    throw new Error("An Ambient Agent Operation Identity marker is malformed.");
  }
  const uniqueMarkers = [...new Set(markers)];
  const serialized =
    uniqueMarkers.length === 0
      ? body
      : `${body}\n\n${FOOTER_START}\n${uniqueMarkers.join("\n")}\n${FOOTER_END}`;
  if (serialized.length > limit) {
    throw new Error(`GitHub ${resource} body exceeds ${limit} characters after Operation Identity.`);
  }
  return serialized;
};

export const issueProviderBody = (body: string, markers: readonly string[], limit = 65_536): string =>
  operationProviderBody("issue", body, markers, limit);

export const commentProviderBody = (body: string, markers: readonly string[], limit = 65_536): string =>
  operationProviderBody("comment", body, markers, limit);

export const parseCommentProviderBody = parseIssueProviderBody;
