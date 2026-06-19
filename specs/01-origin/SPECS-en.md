# Log Collection and Application Error Monitoring System

## 1. Functional Requirements

**Log Asset Management Subsystem:** Manages the data structure of a log record including: Application_Name, Log_Level (INFO, WARN, ERROR, CRITICAL), Message, Timestamp, and Trace_ID. Manages log processing status (Raw log just received, Normalized, Stored).

**High-Speed Ingestion Matrix Subsystem:** Designs a high-load API for other software to continuously send logs to the system (e.g., every user action in another app sends 1 log). The system is required to push all this raw log data into a Message Queue as a buffer for load balancing, because if every incoming log record directly executes an INSERT statement into the SQL DB, the database will be overloaded and crash within minutes.

**Log Parsing & Filtering Engine Subsystem:** Workers consume data from the Message Queue, perform character extraction, data cleaning, and store the data into the DB. If a Worker detects that a log record contains the Level ERROR or CRITICAL, the system immediately triggers a critical alert Event and moves it to a priority queue.

**Alert Locking Mechanism Subsystem:** Upon receiving a critical error Event, the system automatically pushes real-time notifications via WebSocket to the operations engineer's monitoring dashboard and sends messages to Telegram. Applies an alert deduplication mechanism using Redis: If an error occurs 100 consecutive times within 1 minute, the system sends only a single notification to avoid alert fatigue for the engineer.

**Real-time Log Viewer Subsystem:** A display interface showing a continuous real-time log stream (Live Stream View), supporting quick filtering by application type or error level without requiring page reload.

**Additional Feature:** Display permission control (Engineers can only view logs for the applications they manage; System Admin has permission to configure alert thresholds).

---

## 2. Technical Requirements

Concise technical documentation: Architecture diagram of the log data flow passing through Message Queue, database design optimized for fast writing, API documentation.

**The application must meet the following requirements:**

- Be packageable and deployable using Docker (Dockerfile / Docker-compose) — including Backend, DB, Message Queue, and Redis Cache.

- Fully implement the required functions as described in the subsystems.

- Demonstrate a simple workflow: Simulate running a tool that sends 500 logs continuously within 2 seconds to the system → The system receives them without errors → The admin interface displays the incoming logs smoothly.

**Bonus Points:**

- Automatic old log cleanup feature (Log Retention Policy): Periodically run a background job to automatically delete or compress INFO-level system log records older than 7 days to free up hard drive space.

- AI-powered log analysis and classification.

- Application Health Analytics Reporting: Statistics and charts showing error rates among applications per hour to identify which system is the least stable.
