`timescale 1ns/1ps
module uart_rx #(parameter CLKS_PER_BIT = 868)(   // 100MHz / 115200
    input  wire       clk,
    input  wire       rst,
    input  wire       rx,
    output reg  [7:0] data,
    output reg        valid
);
    reg rx1 = 1'b1, rx2 = 1'b1;
    reg [1:0]  s = 0;
    reg [15:0] cnt = 0;
    reg [2:0]  idx = 0;

    always @(posedge clk) begin
        rx1 <= rx; rx2 <= rx1;
        valid <= 1'b0;
        if (rst) begin s <= 0; cnt <= 0; idx <= 0; end
        else case (s)
            0: if (!rx2) begin cnt <= 0; s <= 1; end                 // start edge
            1: if (cnt == (CLKS_PER_BIT-1)/2) begin                  // mid start bit
                   if (!rx2) begin cnt <= 0; idx <= 0; s <= 2; end
                   else s <= 0;
               end else cnt <= cnt + 1;
            2: if (cnt == CLKS_PER_BIT-1) begin                      // data bits, LSB first
                   cnt <= 0; data[idx] <= rx2;
                   if (idx == 7) s <= 3; else idx <= idx + 1;
               end else cnt <= cnt + 1;
            3: if (cnt == CLKS_PER_BIT-1) begin                      // stop bit
                   valid <= 1'b1; cnt <= 0; s <= 0;
               end else cnt <= cnt + 1;
        endcase
    end
endmodule