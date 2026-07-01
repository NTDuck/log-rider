//! Vector similarity search and indexing utilities

use simsimd::ComplexProducts;
use simsimd::SpatialSimilarity;

use usearch::{new_index, Index, IndexOptions, MetricKind, ScalarKind};

/// Entry point for vector similarity testing
pub fn vec1() {
    vec2();
}

/// Test vector indexing and similarity search using USearch
fn vec2() {
    let options = IndexOptions {
        dimensions: 3,
        metric: MetricKind::L2sq,
        quantization: ScalarKind::F32,
        connectivity: 0,
        expansion_add: 0,
        expansion_search: 0,
        multi: true,
    };

    let index: Index = new_index(&options).unwrap();

    let first: [f32; 3] = [0.2, 0.1, 0.2];
    let second: [f32; 3] = [0.2, 0.1, 0.2];

    let _ = index.add(42, &first);
    let _ = index.add(43, &second);
}

/// Test cosine similarity and euclidean distance calculations
fn vec3() {
    let vector_a: Vec<f32> = vec![1.0, 2.0, 3.0];
    let vector_b: Vec<f32> = vec![1.0, 2.0, 3.0];

    // Compute cosine similarity
    let cosine_similarity = f32::cosine(&vector_a, &vector_b).expect("Vectors must be of the same length");

    println!("Cosine Similarity: {}", cosine_similarity);

    // Compute squared Euclidean distance
    let sq_euclidean_distance = f32::sqeuclidean(&vector_a, &vector_b).expect("Vectors must be of the same length");

    println!("Squared Euclidean Distance: {}", sq_euclidean_distance);
}

/// Test complex inner product calculations
fn vec4() {
    let vector_a: Vec<f32> = vec![1.0, 2.0, 3.0, 4.0];
    let vector_b: Vec<f32> = vec![5.0, 6.0, 7.0, 8.0];

    // Compute inner product
    let inner_product = SpatialSimilarity::dot(&vector_a, &vector_b).expect("Vectors must be of the same length");

    println!("Inner Product: {}", inner_product);

    // Compute complex inner products
    let complex_inner_product = ComplexProducts::dot(&vector_a, &vector_b).expect("Vectors must be of the same length");

    let complex_conjugate_inner_product = ComplexProducts::vdot(&vector_a, &vector_b).expect("Vectors must be of the same length");

    println!("Complex Inner Product: {:?}", complex_inner_product);
    println!("Complex Conjugate Inner Product: {:?}", complex_conjugate_inner_product);
}
