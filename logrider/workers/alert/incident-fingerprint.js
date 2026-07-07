import crypto from "crypto";

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][0-2]\d:?[0-5]\d)?\b/g;

const NAMED_ID_RE =
  /\b(trace[_-]?id|request[_-]?id|correlation[_-]?id|span[_-]?id)\s*([=:])\s*["']?[A-Za-z0-9._:/+-]+["']?/gi;

const HEX_ADDRESS_RE =
  /\b0x[0-9a-f]{8,}\b/gi;

const STACK_POSITION_RE =
  /(?<=\.[A-Za-z0-9]+):\d+(?::\d+)?\b/g;

const IPV4_RE =
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;

const LONG_NUMBER_RE =
  /\b\d{6,}\b/g;

export function normalizeApplication(value) {
  return String(value ?? "unknown")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeSeverity(value) {
  const level = String(value ?? "INFO")
    .normalize("NFKC")
    .trim()
    .toUpperCase();

  return ["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"]
    .includes(level)
    ? level
    : "INFO";
}

export function normalizeMessageTemplate(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .replace(ISO_TIMESTAMP_RE, "<timestamp>")
    .replace(UUID_RE, "<uuid>")
    .replace(
      NAMED_ID_RE,
      (_, field, separator) =>
        `${field.toLowerCase()}${separator}<id>`
    )
    .replace(HEX_ADDRESS_RE, "<address>")
    .replace(STACK_POSITION_RE, ":<line>")
    .replace(IPV4_RE, "<ip>")
    .replace(LONG_NUMBER_RE, "<number>")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " "))
    .join("\n")
    .slice(0, 8192);
}

export function createIncidentFingerprint(log, strategy) {
  const applicationName =
    normalizeApplication(log.Application_Name);

  const logLevel =
    normalizeSeverity(log.Log_Level);

  const messageTemplate =
    normalizeMessageTemplate(log.Message);

  const representativeMessage = String(log.Message ?? "");

  let canonicalArray;
  if (strategy === "app_message_exact") {
    canonicalArray = [
      "logrider-incident-signature",
      2,
      applicationName,
      representativeMessage
    ];
  } else if (strategy === "app_level_message_exact") {
    canonicalArray = [
      "logrider-incident-signature",
      2,
      applicationName,
      logLevel,
      representativeMessage
    ];
  } else if (strategy === "app_level_template") {
    canonicalArray = [
      "logrider-incident-signature",
      2,
      applicationName,
      logLevel,
      messageTemplate
    ];
  } else if (strategy === "message_template_only") {
    canonicalArray = [
      "logrider-incident-signature",
      2,
      messageTemplate
    ];
  } else {
    throw new Error(`Unsupported grouping strategy: ${strategy}`);
  }

  const canonical = JSON.stringify(canonicalArray);

  const signature = crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");

  return {
    version: 2,
    algorithm: "sha256",
    groupingStrategy: strategy,
    signature,
    redisKey: `incident:v2:${signature}`,
    applicationName,
    logLevel,
    messageTemplate,
    representativeMessage,
  };
}
