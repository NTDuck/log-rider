import { test, expect, describe } from "bun:test";
import {
  createIncidentFingerprint,
  normalizeApplication,
  normalizeSeverity,
  normalizeMessageTemplate
} from "./incident-fingerprint.js";

const STRATEGY = "app_level_template";

describe("Incident Fingerprinting", () => {
  test("Determinism", () => {
    const log = {
      Application_Name: "payments",
      Log_Level: "ERROR",
      Message: "Database connection failed"
    };
    expect(createIncidentFingerprint(log, STRATEGY)).toEqual(createIncidentFingerprint(log, STRATEGY));
  });

  test("Application separation", () => {
    const log1 = { Application_Name: "app-a", Log_Level: "ERROR", Message: "database unavailable" };
    const log2 = { Application_Name: "app-b", Log_Level: "ERROR", Message: "database unavailable" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).not.toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
  });

  test("Severity separation", () => {
    const log1 = { Application_Name: "app", Log_Level: "ERROR", Message: "database unavailable" };
    const log2 = { Application_Name: "app", Log_Level: "CRITICAL", Message: "database unavailable" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).not.toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
  });

  test("UUID normalization", () => {
    const log1 = { Application_Name: "app", Log_Level: "ERROR", Message: "Request 550e8400-e29b-41d4-a716-446655440000 timed out" };
    const log2 = { Application_Name: "app", Log_Level: "ERROR", Message: "Request de305d54-75b4-431b-adb2-eb6b9e546014 timed out" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
    expect(createIncidentFingerprint(log1, STRATEGY).messageTemplate).toEqual("Request <uuid> timed out");
  });

  test("Timestamp normalization", () => {
    const log1 = { Application_Name: "app", Log_Level: "ERROR", Message: "Failure at 2026-07-07T10:00:00.000Z" };
    const log2 = { Application_Name: "app", Log_Level: "ERROR", Message: "Failure at 2026-07-07T10:15:30.000Z" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
    expect(createIncidentFingerprint(log1, STRATEGY).messageTemplate).toEqual("Failure at <timestamp>");
  });

  test("Stack-line normalization", () => {
    const log1 = { Application_Name: "app", Log_Level: "ERROR", Message: "at execute (/app/service.js:100:12)" };
    const log2 = { Application_Name: "app", Log_Level: "ERROR", Message: "at execute (/app/service.js:207:44)" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).toEqual(createIncidentFingerprint(log2, STRATEGY).signature);

    const log3 = { Application_Name: "app", Log_Level: "ERROR", Message: "at execute (/app/payment.js:100:12)" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).not.toEqual(createIncidentFingerprint(log3, STRATEGY).signature);
  });

  test("Semantic numbers remain distinct", () => {
    const log1 = { Application_Name: "app", Log_Level: "ERROR", Message: "HTTP 404 from upstream" };
    const log2 = { Application_Name: "app", Log_Level: "ERROR", Message: "HTTP 500 from upstream" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).not.toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
  });

  test("Long generated identifiers normalize", () => {
    const log1 = { Application_Name: "app", Log_Level: "ERROR", Message: "Customer 918273645 lookup failed" };
    const log2 = { Application_Name: "app", Log_Level: "ERROR", Message: "Customer 192837465 lookup failed" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
  });

  test("Whitespace and Unicode normalization", () => {
    const log1 = { Application_Name: "app", Log_Level: "ERROR", Message: "Failure   occurred" };
    const log2 = { Application_Name: "app", Log_Level: "ERROR", Message: "Failure occurred" };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
  });

  test("Empty messages", () => {
    const log1 = { Application_Name: "app-a", Log_Level: "ERROR", Message: "" };
    const log2 = { Application_Name: "app-b", Log_Level: "ERROR", Message: null };
    expect(createIncidentFingerprint(log1, STRATEGY).signature).not.toEqual(createIncidentFingerprint(log2, STRATEGY).signature);
    expect(createIncidentFingerprint(log1, STRATEGY).signature).toBeTruthy();
  });

  test("Golden vectors", () => {
    const vectors = [
      {
        input: {
          Application_Name: "payments",
          Log_Level: "ERROR",
          Message: "Request 550e8400-e29b-41d4-a716-446655440000 timed out"
        },
        template: "Request <uuid> timed out"
      }
    ];

    for (const vector of vectors) {
      const fingerprint = createIncidentFingerprint(vector.input, STRATEGY);
      expect(fingerprint.messageTemplate).toEqual(vector.template);
      expect(fingerprint.signature).toBeTruthy();
    }
  });
});
