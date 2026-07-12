import { Button, Input, Space, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";

export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <Space.Compact style={{ width: "100%" }}>
      <Input
        readOnly
        value={value}
        style={mono ? { fontFamily: "monospace", fontSize: 12 } : undefined}
      />
      <Button
        icon={<CopyOutlined />}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          void message.success("Copied");
        }}
      />
    </Space.Compact>
  );
}
