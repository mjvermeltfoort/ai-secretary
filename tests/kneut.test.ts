import { describe, expect, it, vi } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
import { assessMeetingClarity } from "../functions/src/index";
import { normalizeAssessment, validateAssessmentInput } from "../functions/src/kneut";

describe("Kneut backend", () => {
  it("checks ownership before external work", async () => {
    for (const auth of [undefined, {uid:"other",token:{email:"other@example.com",email_verified:true}}]) {
      await expect(assessMeetingClarity.run({auth,data:{meetingId:"m1",text:"test"}} as CallableRequest)).rejects.toMatchObject({code:auth?"permission-denied":"unauthenticated"});
    }
  });
  it("rejects oversized or malformed requests", () => {
    for (const value of [null, {}, {meetingId:"../other",text:"test"}, {meetingId:"m1",text:" "}, {meetingId:"m1",text:"a".repeat(30001)}]) expect(() => validateAssessmentInput(value)).toThrow();
  });
  it("requires source evidence, preserves retained identities and deduplicates", () => {
    const previous = [{id:"old",question:"Wie regelt het?",evidence:"Oude passage"}];
    const result = normalizeAssessment({questions:[{id:"old",question:"Andere formulering?",evidence:"oude tekst"},{id:"",question:"Wie bestelt?",evidence:"We bestellen kleding."},{id:"",question:"Wie bestelt?",evidence:"We bestellen kleding."},{id:"",question:"Welk bedrag?",evidence:"Verzonnen bron"}],transition:false},"We bestellen kleding.",previous);
    expect(result.questions).toHaveLength(2); expect(result.questions[0]).toEqual(previous[0]);
    expect(normalizeAssessment({questions:[],transition:true},"Mark regelt het.",previous).questions).toEqual([]);
    expect(() => normalizeAssessment({},"",[])).toThrow();
  });
});
