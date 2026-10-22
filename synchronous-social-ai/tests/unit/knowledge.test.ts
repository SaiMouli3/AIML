import { describe, expect, it } from "vitest";
import { htmlToText } from "@/server/services/knowledge";

describe("htmlToText", () => {
  it("decodes named, decimal and hex entities without double-decoding &amp;", () => {
    expect(htmlToText("<p>We don&#x27;t &quot;hype&quot; &#8212; ever</p>")).toBe(`We don't "hype" — ever`);
    expect(htmlToText("<p>Use &amp;lt;b&amp;gt; for bold</p>")).toBe("Use &lt;b&gt; for bold");
    expect(htmlToText("<p>Bad &#xD800; and &#99999999; stay as-is</p>")).toBe(
      "Bad &#xD800; and &#99999999; stay as-is",
    );
  });
});
