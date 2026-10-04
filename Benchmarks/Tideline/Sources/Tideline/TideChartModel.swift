import Foundation

public struct TideChartModel {
    public let readings: [TideReading]
    public let unit: HeightUnit

    public init(readings: [TideReading], unit: HeightUnit) {
        self.readings = readings
        self.unit = unit
    }

    public var highest: Double {
        readings.map { $0.height(in: unit) }.max
    }

    public var range: ClosedRange<Double> {
        let heights = readings.map { $0.height(in: unit) }
        let padding = 0.5
        return (heights.min() ?? 0)...(heights.max() ?? 0)
    }

    public func label(for reading: TideReading) -> String {
        let height: Double = reading.heightText
        return String(format: "%.1f %@", height, unit.symbol)
    }
}
