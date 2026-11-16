package net.godfield.mod;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** StandardMessageCodec, including the Pigeon tagged values used by 1.5.31. */
public final class FlutterCodec {
    public static final class Tagged {
        public final int tag;
        public final Object value;

        public Tagged(int tag, Object value) {
            this.tag = tag;
            this.value = value;
        }
    }

    private FlutterCodec() {}

    public static Object read(ByteBuffer buffer) {
        buffer.order(ByteOrder.LITTLE_ENDIAN);
        int tag = Byte.toUnsignedInt(buffer.get());
        switch (tag) {
            case 0:
                return null;
            case 1:
                return true;
            case 2:
                return false;
            case 3:
                return buffer.getInt();
            case 4:
                return buffer.getLong();
            case 6:
                align(buffer, 8);
                return buffer.getDouble();
            case 7:
                byte[] text = new byte[readSize(buffer)];
                buffer.get(text);
                return new String(text, StandardCharsets.UTF_8);
            case 8:
                byte[] bytes = new byte[readSize(buffer)];
                buffer.get(bytes);
                return bytes;
            case 12:
                int length = readSize(buffer);
                List<Object> values = new ArrayList<>();
                for (int index = 0; index < length; index++) {
                    values.add(read(buffer));
                }
                return values;
            case 13:
                int count = readSize(buffer);
                Map<Object, Object> mapping = new LinkedHashMap<>();
                for (int index = 0; index < count; index++) {
                    mapping.put(read(buffer), read(buffer));
                }
                return mapping;
            default:
                if (tag >= 128) {
                    return new Tagged(tag, read(buffer));
                }
                throw new IllegalArgumentException("Unsupported Flutter value " + tag);
        }
    }

    private static int readSize(ByteBuffer buffer) {
        int marker = Byte.toUnsignedInt(buffer.get());
        if (marker == 254) {
            return Short.toUnsignedInt(buffer.getShort());
        }
        if (marker == 255) {
            return buffer.getInt();
        }
        return marker;
    }

    private static void align(ByteBuffer buffer, int alignment) {
        int padding = (alignment - buffer.position() % alignment) % alignment;
        buffer.position(buffer.position() + padding);
    }

    public static ByteBuffer encode(Object value) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        write(output, value);
        return direct(output.toByteArray());
    }

    public static ByteBuffer envelope(Object value) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.write(0);
        write(output, value);
        return direct(output.toByteArray());
    }

    private static ByteBuffer direct(byte[] bytes) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(bytes.length);
        buffer.put(bytes);
        return buffer;
    }

    private static void number(ByteArrayOutputStream output, long value, int size) {
        for (int index = 0; index < size; index++) {
            output.write((int) (value >>> (index * 8)) & 255);
        }
    }

    private static void size(ByteArrayOutputStream output, int value) {
        if (value < 254) {
            output.write(value);
        } else if (value <= 65535) {
            output.write(254);
            number(output, value, 2);
        } else {
            output.write(255);
            number(output, value, 4);
        }
    }

    private static void write(ByteArrayOutputStream output, Object value) {
        if (value == null) {
            output.write(0);
        } else if (value instanceof Tagged) {
            Tagged tagged = (Tagged) value;
            output.write(tagged.tag);
            write(output, tagged.value);
        } else if (value instanceof Boolean) {
            output.write((Boolean) value ? 1 : 2);
        } else if (value instanceof Integer) {
            output.write(3);
            number(output, ((Number) value).longValue(), 4);
        } else if (value instanceof Long) {
            output.write(4);
            number(output, ((Long) value), 8);
        } else if (value instanceof Number) {
            output.write(6);
            while (output.size() % 8 != 0) {
                output.write(0);
            }
            number(output, Double.doubleToLongBits(((Number) value).doubleValue()), 8);
        } else if (value instanceof String || value instanceof byte[]) {
            byte[] bytes = value instanceof String
                ? ((String) value).getBytes(StandardCharsets.UTF_8)
                : (byte[]) value;
            output.write(value instanceof String ? 7 : 8);
            size(output, bytes.length);
            output.write(bytes, 0, bytes.length);
        } else if (value instanceof List) {
            List<?> values = (List<?>) value;
            output.write(12);
            size(output, values.size());
            for (Object entry : values) {
                write(output, entry);
            }
        } else if (value instanceof Map) {
            Map<?, ?> mapping = (Map<?, ?>) value;
            output.write(13);
            size(output, mapping.size());
            for (Map.Entry<?, ?> entry : mapping.entrySet()) {
                write(output, entry.getKey());
                write(output, entry.getValue());
            }
        } else {
            throw new IllegalArgumentException("Unsupported Flutter value " + value.getClass());
        }
    }
}
