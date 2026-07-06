from transformers import pipeline
classifier = pipeline("text-classification", model="kxshrx/infrnce-bert-classifier", top_k=None)
print(classifier("test log message"))
