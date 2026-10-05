import type { UnifiedToolDef } from "../types";

/** The tools the agent can call (arc42 §5 lists them with the Obsidian API each uses). */
export const TOOL_DEFINITIONS: UnifiedToolDef[] = [
  {
    name: "read_document",
    description:
      "Read the content of a markdown document. If no path is given, reads the currently active document. For .canvas files use read_canvas.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document relative to vault root. Omit to read the active document.",
        },
      },
      required: [],
    },
  },
  {
    name: "edit_document",
    description:
      "Edit a markdown document (for .canvas files use edit_canvas instead). Supports three operations: 'replace_all' replaces the entire content, 'find_replace' finds a specific string and replaces it, 'insert' adds content at a position.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to edit the active document.",
        },
        operation: {
          type: "string",
          enum: ["replace_all", "find_replace", "insert"],
          description: "The type of edit to perform.",
        },
        content: {
          type: "string",
          description: "The new content (for replace_all), replacement text (for find_replace), or text to insert.",
        },
        find: {
          type: "string",
          description: "The exact text to find (required for find_replace).",
        },
        position: {
          type: "string",
          enum: ["beginning", "end", "after_frontmatter"],
          description: "Where to insert content (required for insert). 'after_frontmatter' inserts after the --- block.",
        },
      },
      required: ["operation", "content"],
    },
  },
  {
    name: "search_vault",
    description:
      "Search notes and canvases by filename or content. In canvases, content search covers card text, group labels and edge labels and reports the node or edge ID. Returns matching file paths and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (matched against filenames and optionally content).",
        },
        searchContent: {
          type: "boolean",
          description: "Whether to also search inside file contents (slower). Default: false.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Default: 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read the full raw content of any file in the vault by its path. For .canvas files prefer read_canvas, which is shorter and easier to follow.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_canvas",
    description:
      "Read an Obsidian canvas (.canvas file) as a compact outline: each group with the nodes inside it, then nodes outside groups, then edges as 'fromId → toId: label'. Shows node IDs, type, text (shortened) / file / URL, position (top-left x,y) and size. Use the IDs with edit_canvas.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the .canvas file relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_canvas",
    description:
      "Change an Obsidian canvas (.canvas file) with structured operations, applied in order and all-or-nothing (on any error nothing is written). Generates node and edge IDs, keeps the file valid JSON Canvas, places new nodes without overlapping others, and keeps unknown fields. Read the canvas with read_canvas first. Operations: add_node, update_node, move_node, remove_node (also removes its edges), add_edge, update_edge, remove_edge. To create a new canvas, create_file with content '{\"nodes\":[],\"edges\":[]}' and then use this tool.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the .canvas file relative to vault root.",
        },
        operations: {
          type: "array",
          description: "Operations to apply in order.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["add_node", "update_node", "move_node", "remove_node", "add_edge", "update_edge", "remove_edge"],
              },
              id: {
                type: "string",
                description: "Node or edge ID (or ref) to update, move or remove.",
              },
              ref: {
                type: "string",
                description: "add_node/add_edge: a temporary name for the new node or edge, usable as id, near, group, fromNode or toNode in later operations of this call.",
              },
              type: {
                type: "string",
                enum: ["text", "file", "link", "group"],
                description: "add_node: the node type.",
              },
              text: { type: "string", description: "Markdown text of a text node." },
              file: { type: "string", description: "Vault path of a file node; the file must exist." },
              subpath: { type: "string", description: "Heading or block in the file, e.g. '#Heading'. Empty string removes it." },
              url: { type: "string", description: "URL of a link node." },
              label: { type: "string", description: "Label of a group or an edge. Empty string removes it." },
              color: { type: "string", description: "'1'-'6' (red, orange, yellow, green, cyan, purple) or hex like '#FF0000'. Empty string removes it." },
              x: { type: "number", description: "add_node/move_node: left edge. Omit to place automatically." },
              y: { type: "number", description: "add_node/move_node: top edge. Omit to place automatically." },
              width: { type: "number", description: "add_node/update_node: width. add_node has a default per type." },
              height: { type: "number", description: "add_node/update_node: height. add_node has a default per type." },
              near: { type: "string", description: "add_node/move_node: put the node next to this node, without overlapping others." },
              side: {
                type: "string",
                enum: ["top", "right", "bottom", "left"],
                description: "Which side of 'near' to use. Default: right.",
              },
              group: { type: "string", description: "add_node/move_node: put the node inside this group; the group grows if needed." },
              fromNode: { type: "string", description: "add_edge/update_edge: start node ID or ref." },
              toNode: { type: "string", description: "add_edge/update_edge: end node ID or ref." },
              fromSide: { type: "string", enum: ["top", "right", "bottom", "left"], description: "Default: the side facing the other node." },
              toSide: { type: "string", enum: ["top", "right", "bottom", "left"], description: "Default: the side facing the other node." },
              fromEnd: { type: "string", enum: ["none", "arrow"], description: "Default: none." },
              toEnd: { type: "string", enum: ["none", "arrow"], description: "Default: arrow." },
            },
            required: ["op"],
          },
        },
      },
      required: ["path", "operations"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file in the vault. Fails if the file already exists. IMPORTANT: The filename is the title in Obsidian, so never start content with an H1 heading that repeats the filename.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path for the new file relative to vault root (e.g. 'Notes/meeting.md').",
        },
        content: {
          type: "string",
          description: "Content of the new file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in the vault, optionally filtered by folder and/or extension.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Folder path to list (e.g. 'Projects'). Omit to list all files.",
        },
        extension: {
          type: "string",
          description: "Filter by file extension (e.g. 'md'). Omit to include all types.",
        },
      },
      required: [],
    },
  },
  {
    name: "rename_file",
    description: "Rename or move a file in the vault. Can be used to rename a note or move it to a different folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Current path of the file relative to vault root.",
        },
        new_path: {
          type: "string",
          description: "New path for the file relative to vault root.",
        },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "delete_file",
    description: "Move a file to the Obsidian trash. Use with caution.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file to delete relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_properties",
    description:
      "Read the YAML frontmatter properties of a markdown document as structured data. Returns tags, aliases, and all custom properties.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to use the active document.",
        },
      },
      required: [],
    },
  },
  {
    name: "set_properties",
    description:
      "Set or update YAML frontmatter properties on a markdown document. Merges with existing properties. Set a value to null to remove a property.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to use the active document.",
        },
        properties: {
          type: "object",
          description: "Key-value pairs to set in the frontmatter. Arrays (like tags) are supported. Set a value to null to remove that property.",
        },
      },
      required: ["properties"],
    },
  },
  {
    name: "get_backlinks",
    description:
      "Find all notes in the vault that link to a given document. Uses Obsidian's metadata cache for fast lookups.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to use the active document.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_current_datetime",
    description:
      "Get the current date and time in the user's local timezone. Useful for daily notes, journaling, scheduling, or any time-aware task.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "open_document",
    description:
      "Open a document in the Obsidian editor. Use this when the user wants to navigate to, view, or open a specific file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question. Use this when you need more information before proceeding. The conversation will pause until the user responds.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user.",
        },
      },
      required: ["question"],
    },
  },
];
