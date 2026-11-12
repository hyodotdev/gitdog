/**
 * Parses content that may have been edited by gitdog.dev
 * Extracts original content from the <details> block if present
 */

interface ParsedGitdogContent {
  isEdited: boolean;
  originalContent: string | null;
  currentContent: string;
  changesSummary: string | null;
}

const GITDOG_DOMAIN_PATTERN = "gitdog\\.dev";
const EDITED_BY_REGEX = new RegExp(
  `<!--\\s*Edited by ${GITDOG_DOMAIN_PATTERN}\\s*-->`,
  "i",
);
const EDITED_BY_GLOBAL_REGEX = new RegExp(
  `<!--\\s*Edited by ${GITDOG_DOMAIN_PATTERN}\\s*-->\\s*`,
  "gi",
);
const SUB_FOOTER_REGEX = new RegExp(
  `<sub>🤖 Formatted by \\[${GITDOG_DOMAIN_PATTERN}\\]\\([^)]+\\)</sub>\\s*$`,
);
const SUB_FOOTER_GLOBAL_REGEX = new RegExp(
  `<sub>🤖 Formatted by \\[${GITDOG_DOMAIN_PATTERN}\\]\\([^)]+\\)</sub>\\s*`,
  "gi",
);
const ITALIC_FOOTER_REGEX = new RegExp(
  `\\*🤖 Formatted by \\[${GITDOG_DOMAIN_PATTERN}\\]\\([^)]+\\)\\*\\s*$`,
);
const ITALIC_FOOTER_GLOBAL_REGEX = new RegExp(
  `\\*🤖 Formatted by \\[${GITDOG_DOMAIN_PATTERN}\\]\\([^)]+\\)\\*\\s*`,
  "gi",
);

/**
 * Parse gitdog-edited body content
 * Format:
 * <!-- Edited by gitdog.dev --> <!-- Changes: ... --> <details> <summary>Original Content</summary>
 * original content here
 * </details>
 *
 * The actual new content follows after the </details> tag
 */
export function parseGitdogBody(
  body: string | null | undefined,
): ParsedGitdogContent {
  if (!body) {
    return {
      isEdited: false,
      originalContent: null,
      currentContent: "",
      changesSummary: null,
    };
  }

  // Check if edited by gitdog
  const isEdited = EDITED_BY_REGEX.test(body);

  if (!isEdited) {
    return {
      isEdited: false,
      originalContent: null,
      currentContent: body,
      changesSummary: null,
    };
  }

  // Extract changes summary
  const changesMatch = body.match(/<!-- Changes: (.+?) -->/);
  const changesSummary = changesMatch ? changesMatch[1] : null;

  // Extract original content from <details> block (supports multiple languages: "Original Content", "원본 내용", etc.)
  const detailsMatch = body.match(
    /<details>\s*<summary>[^<]*<\/summary>\s*([\s\S]*?)\s*<\/details>/i,
  );
  const originalContent = detailsMatch ? detailsMatch[1].trim() : null;

  // Extract current content (everything after </details>)
  const currentContentMatch = body.match(/<\/details>\s*([\s\S]*?)$/);
  let currentContent = currentContentMatch
    ? currentContentMatch[1].trim()
    : body;

  // Remove leading horizontal rules (---, ___, ***) that may appear at the start
  currentContent = currentContent.replace(/^(\s*[-_*]{3,}\s*\n?)+/, "").trim();

  // Remove gitdog footer if present (both <sub> and italic formats)
  currentContent = currentContent
    .replace(SUB_FOOTER_REGEX, "")
    .replace(ITALIC_FOOTER_REGEX, "")
    .trim();
  currentContent = currentContent.replace(/---\s*$/, "").trim();

  // If parsing failed (originalContent is null but isEdited is true),
  // clean the body by removing the gitdog header and details section
  if (isEdited && !originalContent) {
    // Remove the entire gitdog header and details block from the body for display
    const cleanedBody = body
      .replace(EDITED_BY_GLOBAL_REGEX, "")
      .replace(/<!--\s*Changes:[^>]*-->\s*/gi, "")
      .replace(
        /<details>\s*<summary>[^<]*<\/summary>[\s\S]*?<\/details>\s*/gi,
        "",
      )
      .replace(SUB_FOOTER_GLOBAL_REGEX, "")
      .replace(ITALIC_FOOTER_GLOBAL_REGEX, "")
      .replace(/^(\s*[-_*]{3,}\s*\n?)+/, "")
      .replace(/---\s*$/, "")
      .trim();

    return {
      isEdited,
      originalContent: null,
      currentContent: cleanedBody || currentContent,
      changesSummary,
    };
  }

  return {
    isEdited,
    originalContent,
    currentContent,
    changesSummary,
  };
}
