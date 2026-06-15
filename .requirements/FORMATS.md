```
Tài liệu kỹ thuật ngắn gọn: Sơ đồ kiến trúc luồng dữ liệu Log đi qua Message Queue, thiết kế cơ sở dữ liệu tối ưu cho việc ghi nhanh, tài liệu hướng dẫn API.
 
Ứng dụng cần đáp ứng:

Đóng gói được và triển khai bằng Docker (Dockerfile / Docker-compose) - bao gồm Backend, DB, Message Queue và Redis Cache.

Đầy đủ chức năng yêu cầu theo các phân hệ đã mô tả.

Demo một quy trình đơn giản: Giả lập chạy tool bắn 500 log liên tục trong 2 giây vào hệ thống -> Hệ thống tiếp nhận không lỗi -> Giao diện admin hiển thị log đổ về mượt mà.

Điểm cộng:

Tính năng tự động dọn dẹp log cũ (Log Retention Policy): Định kỳ chạy Job ngầm tự động xóa hoặc nén các bản ghi log hệ thống dạng INFO đã quá 7 ngày để giải phóng dung lượng cho ổ cứng.
AI phân tích, phân loại log

Báo cáo Thống kê Sức khỏe App (Application Health Analytics): Thống kê và vẽ biểu đồ tỷ lệ lỗi giữa các ứng dụng theo giờ để biết hệ thống nào đang kém ổn định nhất.
```
