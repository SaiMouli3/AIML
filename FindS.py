import csv

hypo = ['%', '%', '%', '%', '%', '%']

with open('trainingdata.csv') as csv_file:
    readcsv = csv.reader(csv_file, delimiter=',')
    data = []

    print("\nThe given training examples are:")
    for row in readcsv:
        print(row)
        if row[-1].upper() == "YES":  # Access last element directly
            data.append(row)

print("\nThe positive examples are:")
for x in data:
    print(x)
print("\n")

TotalExamples = len(data)

print("The steps of the Find-s algorithm are :\n", hypo)

d = len(data[0]) - 1  # Get attribute count from first row
for i in range(1, TotalExamples):  # Start from the second example
    for k in range(d):
        if hypo[k] != data[i][k]:
            hypo[k] = '?'
    print(hypo)

print("\nThe maximally specific Find-s hypothesis for the given training examples is :")
print(hypo[:d])  # Print first d elements directly
