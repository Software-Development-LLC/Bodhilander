import React from 'react';

interface GroupColorPickerProps {
  colors: string[];
  /** Currently applied colour, highlighted in the swatch grid. */
  selected: string;
  onSelect: (color: string) => void;
}

/** Swatch grid shown under a group or sub-group's colour dot. */
export const GroupColorPicker: React.FC<GroupColorPickerProps> = ({ colors, selected, onSelect }) => (
  <div className="color-picker">
    {colors.map(color => (
      <button
        key={color}
        className={`color-option ${color === selected ? 'selected' : ''}`}
        style={{ background: color }}
        onClick={() => onSelect(color)}
        aria-label={`Set color to ${color}`}
      />
    ))}
  </div>
);
