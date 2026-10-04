import Foundation

public struct TideReading: Codable, Equatable {
    public let time: Date
    public let heightText: String

    public init(time: Date, heightText: String) {
        self.time = time
        self.heightText = heightText
    }

    @available(*, deprecated, message: "use height(in:)")
    public var metres: Double { Double(heightText) ?? 0 }

    public func height(in unit: HeightUnit) -> Double {
        (Double(heightText) ?? 0) * unit.perMetre
    }
}
