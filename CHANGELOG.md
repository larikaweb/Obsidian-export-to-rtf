# Changelog — Export to RTF

## [1.0.0] — 2025-09-03
### Added
- Support for headings (H1–H6), paragraphs, and blockquotes.
- Support for UL/OL lists with nesting and proper indentation.
- Support for tables.
- Support for callouts (rendered as 1×1 boxed note).
- Inline styles: bold, italic, underline, strikethrough, code, mark (yellow), text/background colors.
- Links: 
  - `http(s)://`, `mailto:` exported as native RTF hyperlinks.
  - Non-standard schemes (`obsidian://`, `tg://`, etc.) exported as plain text `🔗 [Text](URL)`.
- Images: exported as boxed placeholders (file name or full path).
- UI integration: command palette, editor/file context menus, ribbon icon.

### Fixed
- Correct background rendering in Word/LibreOffice (no black boxes).
- Consistent list indentation and bullet rendering.
