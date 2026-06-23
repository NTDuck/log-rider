use cucumber::World;
use steps::websocket_steps::WSWorld;

mod steps;

#[tokio::main]
async fn main() {
    WSWorld::cucumber()
        .run_and_exit("tests/features/websocket.feature")
        .await;
}
