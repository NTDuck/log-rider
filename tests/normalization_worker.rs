use cucumber::World;

mod steps;

#[tokio::main]
async fn main() {
    steps::normalization_worker_steps::NormalizationWorld::cucumber()
        .run("tests/features/normalization_worker.feature")
        .await;
}
