export type MenuCommand =
  | { type: 'project:new' }
  | { type: 'project:open' }
  | { type: 'project:save' }
  | { type: 'project:save-as' }
  | { type: 'edit:undo' }
  | { type: 'edit:redo' }
  | { type: 'tool:select'; tool: 'pen' | 'eraser' }
  | { type: 'tool:color'; color: string }
  | { type: 'tool:color-picker' }
  | { type: 'tool:register-color' }
  | { type: 'tool:width'; width: number }
  | { type: 'tool:register-width' }
  | { type: 'view:zoom-in' }
  | { type: 'view:zoom-out' }
  | { type: 'view:reset-zoom' };

export type MenuPreset =
  | { type: 'color'; value: string }
  | { type: 'width'; value: number };
