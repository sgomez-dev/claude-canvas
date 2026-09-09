// Document Canvas Types

// Document canvas configuration (from Claude)
export interface DocumentConfig {
  content: string;           // Markdown content
  title?: string;            // Optional document title
  readOnly?: boolean;        // Disable selection (default false)
}

// Email preview configuration (extends document for email-preview scenario)
export interface EmailConfig extends DocumentConfig {
  from: string;              // Sender email/name
  to: string[];              // Recipients
  cc?: string[];             // CC recipients
  bcc?: string[];            // BCC recipients
  subject: string;           // Email subject line
}

// Selection result (sent to Claude via IPC)
export interface DocumentSelection {
  selectedText: string;      // The selected text content
  startOffset: number;       // Start character offset in content
  endOffset: number;         // End character offset
  startLine: number;         // Line number (1-based)
  endLine: number;           // End line number
  startColumn: number;       // Column in start line
  endColumn: number;         // Column in end line
}

// Mapping: terminal position to source offset
export interface PositionMapping {
  terminalRow: number;       // 1-based terminal row
  terminalCol: number;       // 1-based terminal column
  sourceOffset: number;      // Character offset in source
}

// Selection state (internal)
export interface SelectionState {
  isSelecting: boolean;
  anchorOffset: number | null;    // Where selection started
  focusOffset: number | null;     // Where selection currently ends
  // Normalized (always start <= end)
  startOffset: number | null;
  endOffset: number | null;
}

